# offact (headless) — PSN account activation

Re-applies the **activation flags** (`account_type="np"` + `account_flags=0x1002`)
to the currently signed-in PS5 user's registry slot, **using the user's
existing PSN-linked `account_id`**. After running, the PS5 treats the
profile as PSN-activated for **Remote Play** purposes - which is exactly
what P5 Manager needs to pair against a profile whose activation flags
got cleared (e.g. after a factory reset / registry restore).

This is a vendored + re-purposed variant of
[ps5-payload-dev/offact](https://github.com/ps5-payload-dev/offact)
(GPLv3+, John Törnblom). Upstream is a fullscreen SDL homebrew with an
on-screen list + IME dialog; this build is **headless** so the P5
Manager backend can send it straight to elfldr (port 9021) and parse
the result, the same way `rp-get-pin.elf` works.

## What changed vs upstream

| | upstream offact | this variant |
| --- | --- | --- |
| **Form** | Homebrew (`.bin`) launched from HEN/Sigma menu | Payload (`.elf`) sent to elfldr:9021 |
| **UI** | Fullscreen SDL ListUI + IME dialog | None - prints status lines to stdout, raises a notification |
| **Slot** | User picks 1..16 manually | Auto-detected via `sceUserServiceGetForegroundUser` + per-slot user_id key |
| **Account ID source** | User types it (IME) or generates a synthetic hash of the local name | **Syncs to the PSN account the manager linked via OAuth** (delivered via FTP trigger file), falling back to the existing on-console registry id. Never invents one. |
| **No PSN signed in?** | Generates a deterministic offline id from the name | Refuses to activate, prints `Activated: failed` with a "sign in to PSN first" notification |
| **Idempotent** | Always writes | Skips writes if the slot is already in sync with the linked PSN id |
| **Deps** | libSDL2 + libSDL2_ttf + libIME + readme.h | libSceRegMgr + libSceUserService - tiny |

The registry helpers in `offact.c` / `offact.h` are kept **unchanged**
from upstream so anyone reading the upstream code recognises them
verbatim. `OffAct_GenAccountId` (the synthetic hash) is still present
in `offact.c` but **no longer called** - we never derive an account_id
from the name.

## Decision logic

Before any registry write, offact reads two account_ids:

1. **`reg_account_id`** — the per-user slot in the PS5 registry (set by
   the firmware when the user signed into PSN on the console).
2. **`trigger_account_id`** — the value the manager wrote into the
   trigger file at `/data/.p5manager-offact` via FTP, which comes from
   the PSN OAuth flow that ran in the web UI.

The trigger is the **source of truth**: whenever it's present, the
registry is synced to it.

| `reg_account_id` | `trigger_account_id` | reason | action |
| --- | --- | --- | --- |
| 0 | present | `adopt` | write trigger id + flags |
| `!= 0` | matches reg | `sync` | no-op (or just fix flags) |
| `!= 0` | differs from reg | `overwrite` | replace reg id with trigger id |
| `!= 0` | absent | `registry` | keep reg id, just fix flags |
| 0 | absent | — | refuse: nothing to activate against |

This is the path the user request describes:

> "if zero → add the linked PSN we have in Remote Play; if non-zero →
> check it matches the linked PSN; if it doesn't, change it to the
> linked one."

## Build

The repo expects the
[ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk) checked
out under `p5managerclient/sdk/` (gitignored — see
`p5managerclient/README.md` for the bootstrap). With that in place, no
env vars are needed:

```bash
cd p5managerclient/offact
make clean && make
# Copy to the payloads dir the backend reads (USER_DATA_DIR/payloads,
# which in the default docker-compose layout is the host /data/payloads
# bind-mounted into the container at the same path).
cp offact.elf /data/payloads/
```

External SDK still works via `PS5_PAYLOAD_SDK=/path/to/sdk make`.

The backend's `POST /api/remoteplay/activate-account` endpoint picks up
the new binary automatically from `data/payloads/`.

## Stdout format

The host parses these exact lines (case-sensitive, anchored on the
colon):

```
User: QuatrixOne
Account ID: wdbIGJpvWSM=
Account ID (hex): 0x23596f9a18c8d6c1
Slot: 1
Activated: yes
```

The `Account ID:` line is **base64 of the 8 raw little-endian bytes** —
deliberately identical to what `rp-get-pin.elf` produces so the host's
parser is the same regex for both payloads.

`Activated:` is one of:

| value | meaning |
| --- | --- |
| `yes` | Wrote something: adopted the linked PSN id (`reason=adopt`), replaced a mismatched one (`reason=overwrite`), or re-applied missing flags. Look at the `[offact] writing (reason=…)` line for which branch ran. |
| `already` | Registry was already in sync (id matches linked PSN, type=`np`, flags=`0x1002`). Pass `--force` to re-write the flags anyway. |
| `failed` | Either neither the trigger file nor the registry had an account_id (sign into PSN on the console or run PSN OAuth in P5 Manager first), or one of the regmgr writes returned non-zero. See preceding `[offact]` lines for diagnostics. |

## On-screen notification

A native PS5 notification appears once with the result, e.g.:

```
OffAct: activated PSN
User: QuatrixOne
ID: 0x23596f9a18c8d6c1
```

A failure (no PSN linked) shows instead:

```
OffAct: no PSN account linked
Sign in to PSN on this profile first
```

## Caveats

- **A real PSN account_id is required from somewhere.** Either the user
  has signed in to PSN on the console (and the firmware wrote the id
  into the registry slot) **or** the manager has run PSN OAuth in the
  web UI (and written the id into the trigger file). If neither
  channel has supplied an id, offact refuses to activate - we never
  synthesise an offline id.
- `--force` re-writes type + flags even when they're already correct
  (useful for diagnostics). It still never replaces the trigger's id
  with something synthetic; the trigger is always the source of truth
  when present.
- **SceShellUI may need to re-read the registry.** If the PS5 was
  previously fully signed out it might not pick up the new state until
  the user re-enters their profile, or until SceShellUI restarts. In
  practice this hasn't been a problem - the system just queries regmgr
  on demand.
