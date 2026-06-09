# P5 Manager

<p>
  <img src="frontend/public/icon-192.svg" alt="P5 Manager icon" width="96" align="left" />
</p>

Web-based all-in-one PS4 / PS5 jailbreak helper: payload delivery, log capture,
file ops, autoload sequences, and Remote Play input control – all from one
browser tab.

<br clear="left" />

## Features

**Payloads**
- Fetch payloads directly from GitHub (releases or blob URLs)
- Upload custom payloads from your computer
- Automatic port detection (LUA → 9026, ELF → 9021)
- Bundled **Default Payloads** auto-downloaded on first run
  (klogsrv, p2jb, common community ELFs); restorable from the UI
- Check & update against newer GitHub releases per payload

**Remote Play (P5 Control tab)**
- **One-click Wake**: WoL + DDP LAUNCH + full RP session in a single
  button press. PSN account is logged in remotely so the "Press PS button"
  picker is skipped automatically on a fresh wake
- **Warm session cache**: stopping a session parks the live RP protocol
  in the background for 3 minutes – the next Start for the same PS5
  resumes the *same* session in O(ms) and never fights the firmware
  "Another Remote Play session" lock
- **Standby from the browser** that reliably puts the console to rest
  (drives the underlying RP control packet and waits for the PS5 to
  acknowledge the transition before tearing down)
- **PSN OAuth → PIN pair wizard** for new consoles
- **On-screen DualSense**: face buttons, dpad, triggers, sticks,
  options / share / PS / touchpad
- **Input Scripts**: tiny DSL (`x`, `circle`, `wait 500`,
  `lstick 0.5 0 200`, `type "Revenge"` …) saved per-PS5 and replayed
  through the live session – great for "launch game X" recipes
- LAN discovery + per-IP status via native DDP

**Logs**
- LUA Log Server (UDP 8080) for `setlogserver.lua` style payloads
- Kernel Log Server (TCP 3232) for `klogsrv` payloads – stdout from any
  ELF sent to the PS5 streams straight to the browser

**File Ops**
- File browser over local mounts, SMB shares and the PS5's own FTP
- HTTP/Torrent **Downloader** with per-job progress, pause/resume,
  retry and removal
- **Convert** workflow: extract archives, pack / unpack PFS via
  `mkpfs`, push to PS5 via FTP — all queued, all stoppable. Works
  directly on files (and folders) already sitting on the PS5 FTP
- Resilient FTP upload with TCP keep-alive, NOOP heartbeat and
  auto-resume so the console stays awake for the entire transfer
- Multi-source browser: stack any number of SMB shares + FTP
  endpoints alongside the local filesystem

**Tasks**
- Single tab listing every background job (downloads, extracts,
  converts, FTP uploads) with per-job progress bars and **per-job**
  start / pause / resume / cancel controls
- Queue state is persisted to disk so jobs survive `docker compose
  restart` / image rebuilds — they come back paused, you press ▶
  to continue
- Nothing starts automatically — you press Start

**Autoload Builder**
- Drag-style step editor with: wait, Wake on LAN, port check,
  send payload, download file, extract, convert, FTP upload,
  **Remote Play session start / stop**, **input script via Remote Play**
- Built-in templates including a one-click **p2jb jailbreak**
  (WoL → wait → Lua port check → send `p2jb.lua` → wait 55 min →
  ELF port check) and a **full-game launch** template
  (RP session → input script → boot wait → ELF port check)
- Steps remain editable after applying a template
- Profile is optional for sequences that don't touch the PS5

**Multiple PS5 profiles** with auto-default, persistent storage that
survives container rebuilds, and a full backup/restore ZIP from Settings.

**Mobile-friendly UI**
- Responsive layout that works the same from a phone, tablet or
  desktop browser — no separate app, no scroll-zoom dance
- Touch-friendly hit targets, mobile keyboard hooks for input
  scripts / text entry on the PS5, and an on-screen DualSense laid
  out for thumb reach
- Builders (Autoload, Convert, FileBrowser) collapse to single
  columns on small screens; setup blocks that are already complete
  stay hidden so the daily flow is one tap

## Requirements

- PS5 console on the same LAN
- For the LUA exploit path: Star Wars Racer Revenge (CUSA03474 USA / CUSA03492 EU)
- PS5 firmware ≤ 12.70 for the LUA payloads
- Docker + Docker Compose (recommended) **or** Node.js 20 for manual runs

## Quick Start

### Docker Compose (recommended)

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

### Manual (Node.js)

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
   - Pair Remote Play once (PSN OAuth → 8-digit PIN shown on the PS5).
     Pairing state survives container rebuilds.
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
| LUA log server           | 8080 | UDP   | for `setlogserver.lua`               |
| Kernel log server        | 3232 | TCP   | for `klogsrv*.elf`                   |
| pyremoteplay sidecar     | 9555 | TCP   | bound to `127.0.0.1`                 |
| PS5 payload LUA          | 9026 | TCP   | on the PS5                           |
| PS5 payload ELF          | 9021 | TCP   | on the PS5                           |

## Persistent Storage

```
./data/
  p5manager.db       # SQLite (profiles, payloads, sequences, scripts, settings)
  payloads/          # uploaded/downloaded payload files
```

The DB has gone through three filenames as the project was renamed:
`payloads.db` (pre-2026-06) → `ps5webmanager.db` → **`p5manager.db`**.
The backend auto-renames any older file it finds on first boot — no
action needed when upgrading.

Backup & restore the whole thing as a ZIP from **Settings → Backup**.

## Tech Stack

- **Backend:** Node.js 20 + Express, native UDP (`dgram`) for PS5 discovery /
  WoL / pair, `sql.js` SQLite, `basic-ftp` for resilient FTP, `child_process`
  spawn for 7z / unrar / mkpfs / smbclient
- **Frontend:** React 18 + Vite, PWA with offline service worker
- **pyremoteplay sidecar:** Python 3.11 + FastAPI + `pyremoteplay` (PSN OAuth,
  registration, Remote Play session, DualSense input emulation) with
  runtime patches that fix the upstream `Session.standby` /
  `async_standby` / `wait` timeout predicates so standby and post-stop
  reconnect behave deterministically
- **Database:** SQLite (sql.js) persisted on a Docker volume

## Platform

- Linux / macOS / Windows with Docker (host networking required)
- Tested on Debian on amd64 / Intel x86_64 hardware

## License

MIT
