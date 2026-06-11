# P5 Manager

<p>
  <img src="frontend/public/icon-192.svg" alt="P5 Manager icon" width="96" align="left" />
</p>

Web-based all-in-one PS4 / PS5 jailbreak helper: payload delivery, log capture,
file ops, autoload sequences, and Remote Play input control – all from one
browser tab.

<br clear="left" />

## Dual-platform: PS4 + PS5

P5 Manager is one app that targets both PlayStation generations.
Every list, picker and the Convert mode pills are filtered by the
active platform so a PS4 mode session can't accidentally fire a PS5
Lua exploit (different port, different ABI).

- Each profile in Settings carries a `console_type` (`PS4`, `PS5`,
  or `Auto-detect`). Auto-detect resolves on the next status poll via
  pyremoteplay `/discover` and persists into the DB so the topbar
  pill, payload badges and pairing wizard all show the right console
- First-run onboarding asks which console you have and pre-selects the
  matching mode
- Payloads, autoload templates and Convert tools each carry a platform
  tag and are filtered automatically by the mode switch

## Features

### Cross-platform features (PS4 + PS5)

**Remote Play (Console tab)**
- **One-click Wake**: WoL + DDP LAUNCH + full RP session in a single
  button press. PSN account is logged in remotely so the "Press PS button"
  picker is skipped automatically on a fresh wake
- **Warm session cache**: stopping a session parks the live RP protocol
  in the background for 3 minutes – the next Start for the same console
  resumes the *same* session in O(ms) and never fights the firmware
  "Another Remote Play session" lock
- **Rest mode from the browser** that reliably puts the console to rest
- **Sub-tabbed pair wizard** that branches on whether the PS5 is already
  signed into PSN:
  - **PSN Activated** path: one-click **Auto-fetch PIN** via
    `rp-get-pin.elf` — reads the PSN account_id + online_id straight from
    the console's regmgr and calls `sceRemoteplayGeneratePinCode`, so
    pairing collapses to a single button press (no manual OAuth, no
    typing the 8-digit code by hand)
  - **Not Activated** path: pushes your OAuth-linked PSN id onto the
    console via `offact.elf` (vendored at `p5managerclient/offact/`,
    reworked to mirror the manager's account_id instead of synthesising
    one), then continues with Auto-fetch PIN + pair
  - Pairing instructions still adapt to PS4 vs PS5 for the manual path
    (different menu, same 8-digit PIN format)
- **On-screen DualShock**: face buttons, dpad, triggers,
  sticks, options / share / PS / touchpad
- **Input Scripts**: tiny DSL (`x`, `circle`, `wait 500`, `lstick 0.5 0 200`,
  `type "Revenge"` …) saved per-profile and replayed through the live
  session – great for "launch game X" recipes
- LAN discovery + per-IP status via native DDP for both PS4 and PS5

**File Ops**
- File browser over local mounts, SMB shares and the console's own FTP
- **Cut / copy / paste, rename and Show info** across local, SMB and
  console FTP — clipboard survives directory hops, cross-mount moves
  fall back to copy+delete automatically
- **Graphical folder picker** modal everywhere a destination path is
  needed (Downloader, Convert, Extract, Autoload step editors, FTP
  upload) — no more typing paths by hand
- HTTP/Torrent **Downloader** with per-job progress, pause/resume,
  retry and removal
- Resilient FTP upload with TCP keep-alive, NOOP heartbeat and
  auto-resume so the console stays awake for the entire transfer
- Multi-source browser: stack any number of SMB shares + FTP
  endpoints alongside the local filesystem

**Tasks**
- Single tab listing every background job (downloads, extracts,
  converts, FTP uploads, PFS / PKG pack-unpack, exFAT pack/unpack,
  PKG installs) with per-job progress bars and **per-job** start /
  pause / resume / retry / cancel controls — every job, including the
  failed ones, gets a Retry
- Dedicated **Install** sub-queue for fake PKG installs on PS5 using
  the vendored `pkg-install.elf` (stages the PKG to the console, calls
  `sceAppInstUtilInstallByPackage`, polls install status)
- Queue state is persisted to disk so jobs survive `docker compose
  restart` / image rebuilds — they come back paused, you press ▶
  to continue
- Nothing starts automatically — you press Start

**Payloads**
- Fetch payloads directly from GitHub (releases or blob URLs)
- Upload custom payloads from your computer — accepts `.lua` / `.elf` /
  `.bin` plus **`.zip`** archives (auto-unpacked, only supported formats
  kept, everything else discarded)
- Automatic platform + port detection (`.lua` → PS5 :9026,
  `.elf` → PS5 :9021, `.bin` / `goldhen` → PS4 :9020)
- Bundled **Default Payloads** auto-downloaded on first run for both
  consoles; restorable from the UI
- **Check** and **Update** are separate buttons — Check just diffs your
  local file against the latest GitHub release, Update actually pulls
  the new binary
- Payloads on disk are also read from `data/payloads/` so you can drop
  files in over the file browser or SSH and they show up immediately

**Autoload Builder**
- Drag-style step editor with: wait, Wake on LAN, port check,
  send payload, download file, extract, convert, FTP upload,
  **Remote Play session start / stop**, **input script via Remote Play**
- Templates filter by the active platform mode
- Profile is optional for sequences that don't touch the console

### PS5-only features

- **Convert tab — unified PS5 converter**: one form with a 4-mode pill
  selector at the bottom that picks the target image format up-front.
  No more sub-tabs to flip between, no more guessing which page builds
  which output.
  - **File → .ffpfsc**: pack a single file (`.exfat`, `.ffpkg`, raw
    `.iso`, …) into a compressed PFS container via [`mkpfs`][mkpfs] —
    mountable on PS5 by ShadowMount+ / MicroMount
  - **Folder → .ffpfsc**: pack a whole game-dump folder into `.ffpfsc`;
    the form transparently promotes a wrapper directory if your dump
    nests the real game root one level down (so mkpfs always sees
    `eboot.bin` at the image root)
  - **File → .exfat**: wrap a single file into a raw exFAT image — the
    Linux equivalent of the build pipeline in
    [kerrdec97/ps5-exfat-builder][exfat-builder]. `mkfs.exfat` formats a
    sparse container, the manager loop-mounts it and rsync streams the
    payload in
  - **Folder → .exfat**: same as above but for a game-dump folder. The
    image root mirrors the source layout (no wrapper dir)

  PFS-specific advanced options (compression level, EKPFS signing,
  case-sensitive flag, …) only appear in the PFS modes; the exFAT modes
  show a one-line hint card instead so the form doesn't feel empty.
  Image size for exFAT is auto-computed (payload + ~10% headroom, min
  64 MiB, max +1 GiB ceiling) and the volume label defaults to the
  output basename (sanitised, 11-char exFAT max).

  Both formats also unpack back to a folder via the File Browser kebab
  menu's "Unpack now" action — `.ffpfsc` → `mkpfs unpack`, `.exfat` →
  loop-mount + rsync out. Everything queues through the same Tasks tab
  with progress + pause + retry + cancel.

  Loop+mount needs `cap_add: [SYS_ADMIN]` + `seccomp:unconfined` + the
  `/dev/loopN` device passthroughs already set in `docker-compose.yml`;
  `mount`/`losetup`/`umount`/`mkfs.exfat` are invoked through a NOPASSWD
  sudoers allowlist so the worker stays on uid 1000 for everything else.

  [mkpfs]: https://github.com/PSBrew/MkPFS
  [exfat-builder]: https://github.com/kerrdec97/ps5-exfat-builder

- Built-in **p2jb jailbreak** Autoload template
  (WoL → wait → Lua port check → send `p2jb.lua` → wait 55 min →
  ELF port check)
- Built-in **full-game launch** template
  (RP session → input script → boot wait → ELF port check)

**Logs (PS5)**
- LUA Log Server (UDP 8080) for `setlogserver.lua` style payloads
- Kernel Log Server (TCP 3232) for `klogsrv` payloads – stdout from any
  ELF sent to the PS5 streams straight to the browser

### PS4-only features

- **Convert tab — PS4 PKG section**: unpack `.pkg` files via flatz's
  classic `unpkg.py` (Python 3 port vendored at
  `backend/src/lib/unpkg.py`). Renders inline below the PS5 converter
  when the platform mode is `PS4` or `All`. Pack is out of scope
  (requires Sony's Windows-only `orbis-pub-cmd`) — produce the PKG
  elsewhere and drop it back via the File Browser
- Bundled **modern GoldHEN** payloads (`goldhen.bin`, `ftp_server.bin`,
  `kernel_debugger.bin`) auto-downloaded for FW 5.05 → 11.00
- Autoload templates: **Load GoldHEN** (wake → wait → send
  `goldhen.bin`), **GoldHEN + FTP ready** (wake → load → start FTP →
  verify :2121)

**Multiple PS5 profiles** with auto-default, persistent storage that
survives container rebuilds, and a full backup/restore ZIP from Settings.
A **global local upload target** (PS5 IP + destination path) lives in
**Settings → Config** so the FTP-upload widgets in File Browser, Convert
and Autoload all share one source of truth.

**Mobile-friendly UI**
- Responsive layout that works the same from a phone, tablet or
  desktop browser — no separate app, no scroll-zoom dance
- Touch-friendly hit targets, mobile keyboard hooks for input
  scripts / text entry on the PS5, and an on-screen DualShock laid
  out for thumb reach
- Builders (Autoload, Convert, FileBrowser) collapse to single
  columns on small screens; setup blocks that are already complete
  stay hidden so the daily flow is one tap

## Requirements

- PS5 console on the same LAN
- For the LUA exploit path: Star Wars Racer Revenge (CUSA03474 USA / CUSA03492 EU)
- PS5 firmware ≤ 12.70 for the LUA payloads
- Docker + Docker Compose (the only supported runtime). Node.js 20 only
  needed if you're hacking on the source — see "Development (Node.js)"
  below

## Quick Start

> **Use Docker Compose.** The Node.js / Python setup further down is
> development-only: it skips the sudoers + capability plumbing that the
> exFAT pipeline needs, doesn't carry the vendored `mkpfs` venv, and
> won't survive a host reboot the way the compose stack does. Run the
> stack with `docker compose` for any real install.

### Docker Compose (the supported install path)

```bash
git clone https://github.com/psdeviant/p5-manager.git
cd p5-manager
docker compose up -d --build
```

The app will be available at `http://your-server:3001`.

Two containers come up:

| Service        | Image                  | Purpose                                                                  |
|----------------|------------------------|--------------------------------------------------------------------------|
| `app`          | `p5-manager-app`       | Node/Express backend + bundled React frontend                            |
| `pyremoteplay` | `pyremoteplay-sidecar` | Python FastAPI sidecar wrapping `pyremoteplay` for OAuth, pairing, input |

Both run in `network_mode: host` so PS5 discovery, Wake on LAN broadcasts and
Remote Play UDP streams work without port forwarding.

Updates: `git pull && docker compose up -d --build`. The `data/` volume
(SQLite DB, payloads, downloads, mkpfs work dir) is bind-mounted so
nothing is lost across rebuilds.

### Development (Node.js, **not** for normal use)

This path is only for working on the source itself — building the
frontend live, debugging the backend with a real debugger, etc.
**Not a substitute for the Docker setup**: the PS5 exFAT pipeline
needs the container's sudoers + `cap_add: [SYS_ADMIN]` plumbing,
which a bare-metal Node run cannot provide. Run the compose stack
instead and only drop into manual mode when you're editing code.

```bash
cd backend && npm install
cd ../frontend && npm install

cd ../backend && npm run dev          # backend on :3001
cd ../frontend && npm run dev         # frontend on :3000
```

For the Remote Play features you still need the `pyremoteplay` Python sidecar
running on `127.0.0.1:9555`:

```bash
cd pyremoteplay
pip install -r requirements.txt
python server.py
```

## Usage

1. **Add a PS5 Profile** in Settings (IP + MAC). The first profile is auto-default.
2. **Fetch / upload payloads** in the Payloads tab. Click ✨ Defaults if you
   want the bundled community payloads.
3. **P5 Control tab**:
   - Pair Remote Play once via the sub-tabbed wizard:
     - **PSN Activated** (PS5 already signed into PSN): just hit
       **🪄 Auto-fetch PIN** → **🤝 Pair**. Done.
     - **Not Activated** (no PSN on the console): link your Sony
       account once with OAuth, **🪄 Push linked PSN account to console**
       to sync the registry via `offact.elf`, then Auto-fetch PIN → Pair.
     - Pairing state and the PSN link both survive container rebuilds.
   - Hit **Wake** – it does WoL, dismisses the account picker, opens the
     RP session and you're ready to send inputs.
   - When you're done, **Disconnect** soft-stops into the warm cache so
     re-opening the session a few minutes later is instant; **Force reset**
     fully releases the console for someone else.
4. **Autoload tab** — build a sequence or load the **p2jb jailbreak** or
   **full-game launch** templates and hit Run.
5. **Tasks tab** for every other long-running job (downloads, extracts, FTP).
6. **Logs tab** for kernel + LUA log output.
7. **Settings → Backup** to download/restore a full state ZIP (profiles,
   payloads, sequences, input scripts, settings).

### Supported GitHub URLs (Payloads)

```
https://github.com/owner/repo/releases                       # latest release
https://github.com/owner/repo/releases/tag/v1.05             # specific tag
https://github.com/owner/repo/blob/main/payloads/file.lua    # blob
https://raw.githubusercontent.com/owner/repo/main/file.lua   # raw
```

## Default Ports

| Component                | Port | Proto | Notes                                |
|--------------------------|------|-------|--------------------------------------|
| Web UI + REST API        | 3001 | TCP   | Backend (also serves built frontend) |
| LUA log server           | 8080 | UDP   | for `setlogserver.lua` (PS5)         |
| Kernel log server        | 3232 | TCP   | for `klogsrv*.elf` (PS5)             |
| pyremoteplay sidecar     | 9555 | TCP   | bound to `127.0.0.1`                 |
| PS5 payload LUA          | 9026 | TCP   | on the PS5                           |
| PS5 payload ELF          | 9021 | TCP   | on the PS5                           |
| PS4 GoldHEN payload      | 9020 | TCP   | on the PS4 (modern GoldHEN sender)   |
| PS4 GoldHEN FTP          | 2121 | TCP   | on the PS4, once `ftp_server.bin` loads |
| Remote Play (DDP)        | 9295 | UDP   | discovery + wake, both PS4 and PS5   |
| Remote Play (control)    | 9296 | UDP   | both PS4 and PS5                     |

## Vendored PS5 payloads (`p5managerclient/`)

The PS5 payloads we ship + drive from the UI are vendored in
`p5managerclient/` (gitignored `sdk/` subfolder for the
[ps5-payload-dev SDK](https://github.com/ps5-payload-dev/sdk)). Each
folder is a hermetic build with its own `Makefile` and README:

| Folder                          | Payload          | Purpose                                                                                                             |
|---------------------------------|------------------|---------------------------------------------------------------------------------------------------------------------|
| `p5managerclient/rp-get-pin/`   | `rp-get-pin.elf` | Drives `sceRemoteplayGeneratePinCode` and reads the foreground user's PSN id from regmgr. Powers the Auto-fetch PIN button. |
| `p5managerclient/offact/`       | `offact.elf`     | Pushes the manager's OAuth-linked PSN `account_id` onto the console (adopt / sync / overwrite). Powers the Not Activated tab. |
| `p5managerclient/pkg-install/`  | `pkg-install.elf` | Calls `sceAppInstUtilInstallByPackage` for fake PKGs the manager stages on the PS5. Powers the Install queue.        |

Build them with `make` inside each folder (needs the SDK in
`p5managerclient/sdk/`) and copy the resulting `.elf` into
`/data/payloads/` — the running container picks them up automatically.
The release bundle also ships pre-built copies under
**Payloads → ✨ Defaults**, so you don't have to compile anything to
use the manager.

## Persistent Storage

```
./data/
  p5manager.db       # SQLite (profiles, payloads, sequences, scripts, settings)
  payloads/          # uploaded/downloaded payload files
  downloads/         # default destination for the Downloader
  mkpfs/             # mkpfs + exFAT scratch / staging (also the default output dir for Convert)
```

The DB has gone through three filenames as the project was renamed:
`payloads.db` (pre-2026-06) → `ps5webmanager.db` → **`p5manager.db`**.
The backend auto-renames any older file it finds on first boot — no
action needed when upgrading.

Backup & restore the whole thing as a ZIP from **Settings → Backup**.

### Container privileges for the exFAT pipeline

The two exFAT modes in the Convert tab loop-mount `.exfat` images
inside the container, which needs more than the default Docker security
envelope. `docker-compose.yml`
sets all of this for you out of the box:

- `cap_add: [SYS_ADMIN, MKNOD]` so `mount(2)` / `losetup(8)` can run
- `security_opt: [apparmor:unconfined, seccomp:unconfined]` because the
  default seccomp profile drops `mount`, `umount2`, `mknod` and the loop
  `ioctl`s even when SYS_ADMIN is in the bounding set
- `devices: /dev/loop-control, /dev/loop0..7, /dev/fuse` — the actual
  block devices `losetup -f` picks from
- `group_add: ["6"]` so uid 1000 can open the `root:disk`-owned loop
  device nodes

Inside the image the Dockerfile installs `exfatprogs` + `util-linux` +
`sudo`, creates the `p5manager` user (uid 1000), and writes a
`/etc/sudoers.d/p5manager-exfat` NOPASSWD allowlist that's strictly
limited to `losetup`, `mount`, `umount`, `mkfs.exfat`. No other binary
in the manager can use sudo. If you'd rather not run with relaxed
seccomp/AppArmor, comment those two lines out of `docker-compose.yml`
and the two exFAT modes in the Convert tab will fail with a clear
"must be superuser" in the job log — every other Convert / Tasks
feature keeps working.

## Tech Stack

- **Backend:** Node.js 20 + Express, native UDP (`dgram`) for PS5 discovery /
  WoL / pair, `sql.js` SQLite, `basic-ftp` for resilient FTP, `child_process`
  spawn for 7z / unrar / mkpfs / `mkfs.exfat` + `losetup` + `mount` (sudo-
  wrapped, for the PS5 exFAT pipeline) / smbclient
- **Frontend:** React 18 + Vite, PWA with offline service worker
- **pyremoteplay sidecar:** Python 3.11 + FastAPI + `pyremoteplay` (PSN OAuth,
  registration, Remote Play session, DualShock input emulation) with
  runtime patches that fix the upstream `Session.standby` /
  `async_standby` / `wait` timeout predicates so standby and post-stop
  reconnect behave deterministically
- **Database:** SQLite (sql.js) persisted on a Docker volume

## Platform

- Linux / macOS / Windows with Docker (host networking required)
- Tested on Debian on amd64 / Intel x86_64 hardware

## Credits & Acknowledgements

P5 Manager glues together a lot of independent scene work — none of the
PS4/PS5 console parts would exist without these projects and the people
who maintain them. If you find this tool useful, star their repos too.

### Conversion / image tooling

- **[PSBrew / MkPFS](https://github.com/PSBrew/MkPFS)** — `mkpfs`, the
  PFS (`.ffpfsc` / `.ffpfs`) packer and unpacker. Drives every PS5 PFS
  mode in the Convert tab. Installed straight from PyPI into a per-app
  venv so the "Update mkpfs" button can pull a new release without a
  rebuild
- **[PSBrew / MicroMount](https://github.com/PSBrew/MicroMount)** —
  source of the bundled MicroMount payload + config editor in the
  Convert tab's MicroMount section
- **[kerrdec97 / ps5-exfat-builder](https://github.com/kerrdec97/ps5-exfat-builder)**
  — the Windows-side reference for the exFAT image build pipeline. Our
  Linux port (`backend/src/lib/exfat.js`) mirrors the same Allocate →
  `mkfs.exfat` → mount → copy → unmount sequence but uses kernel loop
  + rsync instead of OSFMount + robocopy
- **flatz** — original public-domain `unpkg.py` PS4 PKG parser /
  extractor (rev 0x00000008, 2017). Our `backend/src/lib/unpkg.py` is a
  Python 3 port (originally by **CelesteBlue**) trimmed to ship as a
  single hermetic file

### Console payloads + jailbreak

- **[ps5-payload-dev / sdk](https://github.com/ps5-payload-dev/sdk)** —
  the PS5 user-mode payload SDK used to build every ELF under
  `p5managerclient/` (`rp-get-pin.elf`, `offact.elf`, `pkg-install.elf`).
  `prospero-clang`, the libc/SCE stubs and the ptrace + regmgr helpers
  all come from this project
- **etaHEN team** — the etaHEN payload (PS5 jailbreak / kernel exploit
  + homebrew enabler). Pulled in as a "Default Payload" so a fresh
  install can wake a console and inject etaHEN in two clicks
- **GoldHEN team (sleirsgoevy et al.)** — the PS4 GoldHEN payload
  (`goldhen.bin`, `ftp_server.bin`, `kernel_debugger.bin`). Same default-
  payload treatment for PS4 profiles
- **[gezine](https://github.com/gezine)** — author of **p2jb**, the PS5
  Lua-port jailbreak exploit driven from the manager

### Remote Play

- **[ktnrg45 / pyremoteplay](https://github.com/ktnrg45/pyremoteplay)**
  — the Python Remote Play protocol library powering the sidecar
  container. PSN OAuth, console registration, Remote Play session
  lifecycle and DualShock input emulation are all upstream; our sidecar
  just wraps it in a FastAPI surface and patches a couple of timeout
  predicates (`Session.standby` / `async_standby` / `wait`) so
  standby + post-stop reconnect behave deterministically

### Misc

- **DietPi / Debian** — the host platform this is daily-driven on
- Everyone whose forum posts, GitHub issues and IRC pings filled in the
  undocumented quirks of regmgr, sceRemoteplayGeneratePinCode,
  ShadowMount+ and the rest of the homebrew stack. Too many to list
  individually — thank you

If you spot something we should be crediting and currently aren't,
open an issue and we'll add it.

## License

MIT
