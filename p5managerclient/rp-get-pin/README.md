# ps5-remoteplay-get-pin (vendored)

Generates a Remote Play pairing PIN + PSN online_id (display name) +
base64 Account ID by calling `sceRemoteplayGeneratePinCode` inside
`SceShellUI` via `ptrace`. Required for **offline-activated accounts**
where the Settings → Remote Play menu on the PS5 refuses to show the PIN.

This is a vendored copy of [idlesauce/ps5-remoteplay-get-pin](https://github.com/idlesauce/ps5-remoteplay-get-pin)
with local patches; the compiled `rp-get-pin.elf` lives in `data/payloads/`
and is invoked by the backend's `POST /api/remoteplay/get-pin` endpoint,
which the Remote Play tab's "Auto-fetch PIN" button calls.

In addition to streaming the PIN/User/Account ID over the TCP socket to
the host, the payload also raises a system notification on the PS5
screen every ~5.75 s during the 120 s pairing window, e.g.:

```
Pin code: 4925 0164
User: QuatrixOne
Account ID: wdbIGJpvWSM=

Seconds left: 113
```

## Local patches (vs upstream)

These six patches make the payload work reliably under our typical
runtime: PS5 12.70 with kstuff + shadowmount + GoldHEN active. Tracked
here so a future upstream rebase is mechanical.

1. **`main.c` — unbuffered stdio**
   `elfldr` connects the ELF's `stdout` to the inbound TCP socket, but
   FreeBSD libc defaults sockets to **full** buffering, which means
   `printf("Pin code: …")` never reached the host backend until the
   payload exited 120 s later. `setvbuf(stdout, NULL, _IONBF, 0)` at the
   very top of `main()` forces unbuffered writes - every printf goes
   straight to the TCP socket.

2. **`main.c` — graceful old-instance cleanup via SIGTERM (loop)**
   Upstream tries SIGTERM once and exits with "Send again to get a new
   pin code". We instead loop SIGTERM up to 15 times with 500 ms
   backoffs, relying on the WALL_BUDGET-bounded `tracer_call` (patch #5)
   to make the old copy unstick and reach `tracer_finalize()`. The old
   payload's `PT_DETACH` lets `SceShellUI`'s libSceRemoteplay stay in a
   sane state, so the new instance can immediately get a PIN. Only
   falls back to `SIGKILL` as a last resort - that abrupt detach leaves
   libSceRemoteplay permanently returning `0x80FC0004` (service not
   initialised) until SceShellUI is rebooted, so we avoid it.

3. **`main.c` — retry symbol-resolve and `sceRemoteplayGeneratePinCode`**
   After a fresh SceShellUI respawn `libSceRemoteplay.sprx` is not
   immediately mapped (~2-3 s lag) and the service itself returns
   `0x80FC0004` for several seconds. We poll `resolve_symbol_from_lib_for_pid`
   for 8 s, then poll `GeneratePinCode` for 15 s, so the payload works
   on the first try even when SceShellUI was just respawned.

4. **`ptrace.c` — `safe_copyin` / `safe_copyout` with PT_IO fallback**
   On PS5s running kstuff, `mdbg_copyin` / `mdbg_copyout` return EPERM
   because kstuff's syscall hook rejects mdbg writes from non-kernel
   space. We try mdbg first, then transparently fall back to `PT_IO`
   (with `PIOD_READ_D` / `PIOD_WRITE_D`) which goes through the ptrace
   channel and is not affected by the mdbg hook. This is THE critical
   fix - without it the payload silently fails because the trampoline
   return address never gets written to the tracee's stack.

5. **`ptrace.c` — bounded poll-wait loop in `tracer_call`**
   Upstream treats any non-`SIGTRAP` stop as fatal and uses a blocking
   `waitpid()` that can hang forever. Replacement:
     - non-blocking `waitpid(WNOHANG)` + 10 ms poll cadence,
     - 5 s wall-clock deadline (= a stuck instance unsticks and can be
       cleanly SIGTERMed by a subsequent run),
     - swallows control-plane stops (`SIGSTOP`/`SIGTSTP`/`SIGTTIN`/`SIGTTOU`)
       by passing `0` to `PT_CONTINUE`, forwards everything else,
     - caps at 128 swallowed signals so a signal storm can't loop us
       forever.
   Lets the payload coexist with kstuff's periodic signal injection.

6. **`ptrace.c` — re-assert authid + caps before each call, INT3 canary check**
   Even with privileged authid set in `tracer_init`, some kernel paths
   reset our ucred under load. We re-assert `0x4800000000010003` + full
   caps right before each `tracer_call`. We also verify libkernel starts
   with `0xCC` (the INT3 trap canary) on the first call so a missing
   canary surfaces immediately instead of hanging in waitpid.

7. **`main.c` — PSN online_id (display name) capture**
   Upstream only reports the base64 Account ID. We additionally read the
   user's `SCE_REGMGR_ENT_KEY_USER_*_NP_online_id` key (base `0x0780B00C`,
   per-user stride `0x10000`, key type "string", max 17 bytes) via
   `sceRegMgrGetStr` after `get_current_user_registry_index()` resolves
   the slot. The display name is printed on stdout as `User: <name>`
   between the `Pin code:` and `Account ID:` lines, and is included in
   the on-screen notification.

   We deliberately do **not** use `sceUserServiceGetNpOnlineId` - on
   kstuff-modified PS5s it blocks forever in a non-cancellable kernel
   wait, and the process becomes unkillable even with `SIGKILL`. Direct
   regmgr access is non-blocking and matches the pattern we already use
   for `account_id`.

## Build

The repo expects the
[ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk) checked
out under `p5managerclient/sdk/` (gitignored — see
`p5managerclient/README.md` for the bootstrap). You also need
`clang-19` + `lld-19` on the host (the SDK wraps LLVM 19).

```bash
cd p5managerclient/rp-get-pin
make clean && make
cp rp-get-pin.elf /data/payloads/
```

External SDK still works via `PS5_PAYLOAD_SDK=/path/to/sdk make`.

The backend picks up the new binary on next `GET /api/payloads` (the
filesystem scan in `backend/src/lib/defaultPayloads.js` registers it
idempotently). No container rebuild required as long as `data/payloads/`
is bind-mounted (it is, per `docker-compose.yml`).

## Usage (manual)

For debugging without the UI:

```bash
socat -t 99999999 - TCP:<ps5-ip>:9021 < rp-get-pin.elf
```

stdout streams back `Pin code: NNNN NNNN`, `Account ID: <base64>`,
`Timeout: 120 seconds`, then the 120 s pairing loop notifies the PS5
screen every ~5.75 s with the same data.

## Behaviour

- **First call** (fresh boot, no old instance): ~3 s, returns PIN +
  Account ID on stdout.
- **Subsequent calls** (old instance still in its 120 s pairing loop):
  ~5 s — SIGTERM cleans up the old copy, 1 s SceShellUI settle, fresh
  PIN generated.
- **Worst case** (SIGTERM doesn't unstick the old instance within 7.5 s):
  falls back to SIGKILL and warns. SceShellUI may need reboot via
  `Settings → Restart PS5` afterwards because libSceRemoteplay will
  return `0x80FC0004` permanently.

## Known limitations

- The Remote Play service inside SceShellUI doesn't recover from an
  abrupt tracer kill - SIGKILL escape hatch is destructive. The
  graceful-SIGTERM path normally suffices.
- Pairs only the currently-foreground PSN user. Switch user on the PS5
  first if you want a different account.

## Upstream

- Source: <https://github.com/idlesauce/ps5-remoteplay-get-pin>
- Last sync: commit `6373197` (`Update main.yml`)
- Thanks: Nicit (testing), [astrelsky](https://github.com/astrelsky/)
  (ptrace examples), [john-tornblom](https://github.com/john-tornblom/)
  (SDK + ptrace examples).
