# pkg-install — Headless fake-PKG installer payload for PS5

The companion ELF for P5 Manager's **Install** queue. Reads a staged
`.pkg` path from a trigger file the manager writes via FTP, then calls
the same private Sony installer API (`sceAppInstUtilInstallByPackage`)
that the on-PS5 Debug Settings package installer uses.

## What it does

1. Reads `/data/.p5manager-install` (or whatever you configured under
   **Settings → Config → PKG installer → Trigger file on PS5**). The
   format is:

   ```
   /data/pkg-stage/Game.pkg
   Game.pkg
   ```

   First non-empty line = absolute path of the staged `.pkg`; second
   line is an optional display name. The manager also accepts a JSON
   fallback (`{ "pkg_path": "…", "content_name": "…" }`) so this
   payload understands both shapes.
2. `sceKernelLoadStartModule("/system/common/lib/libSceAppInstUtil.sprx")`
   then `sceAppInstUtilInitialize()`.
3. `sceAppInstUtilInstallByPackage(&meta, &pkg_info, &playgo)` with
   `meta.uri` = the staged `.pkg` path. The call queues the install on
   the DPI daemon and returns the `content_id` we use to track it.
4. Polls `sceAppInstUtilGetInstallStatus(content_id, &status)` once a
   second for up to 30 minutes, printing one `status: <state>` line
   each time the status string changes and one `progress: NN%` line
   each time the downloaded/total percentage changes. The manager
   parses both, surfaces them on the queue item, and treats
   `status: playable` as a successful exit.

This is a vendored implementation derived from etaHEN's public PS5 PKG
installation writeup and the ps5-payload-dev SDK samples. We do **not**
link `-lSceAppInstUtil` — the payload resolves all three entry points
at runtime via `sceKernelDlsym`, so the binary keeps running across
firmwares where the SDK stub set drifts.

## Build

The repo expects the
[ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk) checked
out under `p5managerclient/sdk/` (gitignored — see
`p5managerclient/README.md` for the one-shot bootstrap). With that in
place, no env vars are needed:

```bash
cd p5managerclient/pkg-install
make clean && make

# Drop it where the manager picks payloads up from:
cp pkg-install.elf /data/payloads/
```

If you keep an external SDK install elsewhere, the Makefile still
honours `PS5_PAYLOAD_SDK`:

```bash
PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk make
```

Then in P5 Manager → **Settings → Config → PKG installer (fake .pkg)**:

1. Reload the page so the new ELF shows up.
2. Pick `pkg-install.elf` from the *Installer payload* dropdown.
3. Hit **💾 Save PKG Installer**.

## Trigger / stage paths

You can override either path globally from the Settings tab. If you
move the trigger path you should rebuild the payload with a matching
`TRIGGER_PATH`:

```bash
make TRIGGER_PATH=/data/my-installer-trigger.txt
```

(or recompile and accept the default `/data/.p5manager-install`.)

## Stdout format the manager parses

```
[pkg-install] starting (build Jun 11 2026 12:05:00)
[pkg-install] trigger: /data/.p5manager-install
[pkg-install] pkg:     /data/pkg-stage/Game.pkg
[pkg-install] name:    Game.pkg
[pkg-install] size:    52487298 bytes
[pkg-install] init ok
[pkg-install] queued. content_id=UP1234-CUSA00001_00-XXXXXXXXXXXXXXXX
status: installing
progress: 12%
progress: 34%
status: promoting
progress: 89%
status: playable
[pkg-install] done
```

The two important prefixes are:

| prefix              | what the manager does                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `status: …`         | Sets `item.install_status`; `playable` finishes the queue item OK.    |
| `progress: NN%`     | Updates `item.progress` for the queue UI's progress bar.              |
| `[pkg-install] …`   | Streamed verbatim into the per-item log dropdown.                     |

On any fatal step we print `status: error` first, then a
`[pkg-install] error: <message>` line, then exit 1 — the manager maps
that to a failed queue item with `item.error` set to the message.

## Limitations

- **Game pkgs only** (`CUSA-…`, `PPSA-…`, `PCSA-…`, `EP/UP/JP-…`). For
  Sony's NPXS-prefix system pkgs use the on-PS5 Debug Settings → Game
  → Package Installer; `sceAppInstUtilInstallByPackage` freezes
  Sony's mgmt service mid-install on those, same behaviour ps5upload
  documents in its README.
- **Requires ShellCore-level auth ID**. The ps5-payload-dev SDK's
  default startup elevates auth ID before `main()` runs, so this Just
  Works™ when sent to elfldr on a jailbroken console.
- **Asynchronous.** We poll until `playable`, but the PS5 still has
  some final filesystem promotion to do after we exit. If you see the
  tile appear on the dashboard a few seconds after the queue item
  flips to **Completed**, that's expected.
- **One install at a time.** The DPI daemon serialises, so the
  manager's worker only ever runs one install job concurrently per
  console.

## Credits

- [etaHEN](https://github.com/etaHEN/etaHEN) — *PS5 Package
  Installation: Writeup* (struct layouts + initialization sequence
  for `sceAppInstUtilInstallByPackage`).
- [ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk) — the
  toolchain + auth-id elevation runtime.
- [phantomptr/ps5upload](https://github.com/phantomptr/ps5upload) —
  proof that the DPI-daemon path is the most reliable install API on
  current firmware (the manager's queue is modelled on the same
  upload → install split).
