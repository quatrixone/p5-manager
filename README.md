# PS5WebPayload Manager

Web-based all-in-one PS5 jailbreak helper: payload delivery, log capture, file
ops, autoload sequences, and Remote Play input control – all from one browser
tab.

## Features

**Payloads**
- Fetch payloads directly from GitHub (releases or blob URLs)
- Upload custom payloads from your computer
- Automatic port detection (LUA → 9026, ELF → 9021)
- Bundled **Default Payloads** auto-downloaded on first run
  (klogsrv, p2jb, common community ELFs); restorable from the UI

**PS5 Control (unified tab)**
- Wake on LAN over native UDP (no chiaki-cli binary)
- Credential capture from chiaki-ng / ps5-wake clients
- LAN discovery + per-IP status (FAYT discovery via the chiaki sidecar)
- Legacy native UDP PIN pair (kept for compatibility)
- **Remote Play** via embedded Python sidecar (`pyremoteplay`):
  PSN OAuth wizard → PIN pair → input-only session → on-screen
  DualSense controller (face buttons, dpad, triggers, sticks, options/share/PS/touchpad)
- **Input Scripts**: small DSL (`x`, `circle`, `wait 500`, `lstick 0.5 0 200`…)
  saved per-PS5 and replayed through the Remote Play session

**Logs**
- LUA Log Server (UDP 8080) for `setlogserver.lua` style payloads
- Kernel Log Server (TCP 3232) for `klogsrv` payloads

**File Ops**
- File browser over local mounts + SMB shares
- HTTP/Torrent **Downloader** (queued, pausable)
- **MicroMount** workflow: extract archives, convert PKG → PFS,
  push to PS5 via FTP — all queued
- Resilient FTP upload with TCP keep-alive, NOOP heartbeat and
  auto-resume / retry (PS5 won't sleep mid-upload anymore)

**Queue**
- Single tab listing every background job (downloads, extracts,
  converts, FTP uploads) with per-job progress bars,
  pause/resume/cancel and global Start/Pause controls
- Nothing starts automatically — you press Start

**Autoload Builder**
- Drag-style step editor with: wait, Wake on LAN, port check,
  send payload, download file, extract, convert, FTP upload,
  **input script via Remote Play**
- Built-in templates including a one-click **p2jb jailbreak**
  (WoL → wait → Lua port check → send `p2jb.lua` → wait 55m → ELF
  port check)
- Profile is optional for sequences that don't touch the PS5

**Multiple PS5 profiles** with auto-default for first profile, plus
persistent storage that survives container rebuilds and a full
backup/restore ZIP from Settings.

## Requirements

- PS5 console on the same LAN
- For the LUA exploit path: Star Wars Racer Revenge (CUSA03474 USA / CUSA03492 EU)
- PS5 firmware ≤ 12.70 for the LUA payloads
- Docker + Docker Compose (recommended) **or** Node.js 20 for manual runs

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/psdeviant/ps5webpayload-manager.git
cd ps5webpayload-manager
docker compose up -d --build
```

The app will be available at `http://your-server:3001`.

Two containers come up:

| Service  | Image                       | Purpose                                                  |
|----------|-----------------------------|----------------------------------------------------------|
| `app`    | `ps5webpayload-manager-app` | Node/Express backend + bundled React frontend            |
| `chiaki` | `chiaki-sidecar`            | Python FastAPI sidecar wrapping `pyremoteplay` for OAuth, pairing, input |

Both run in `network_mode: host` so PS5 discovery, Wake on LAN broadcasts and
Remote Play UDP streams work without port forwarding.

### Manual (Node.js)

```bash
cd backend && npm install
cd ../frontend && npm install

cd ../backend && npm run dev          # backend on :3001
cd ../frontend && npm run dev         # frontend on :3000
```

For the Remote Play features you still need the `chiaki` Python sidecar
running on `127.0.0.1:9555`:

```bash
cd chiaki
pip install -r requirements.txt
python server.py
```

## Usage

1. **Add a PS5 Profile** in Settings (IP + MAC). The first profile is auto-default.
2. **Fetch / upload payloads** in the Payloads tab. Click ✨ Defaults if you
   want the bundled community payloads.
3. **PS5 Control tab**:
   - Wake the console with Wake on LAN
   - Pair Remote Play (PSN OAuth → 8-digit PIN shown on the PS5)
   - Start a session and drive it from the virtual controller, or save
     and replay input scripts
4. **Autoload tab** — build a sequence or load the **p2jb jailbreak** template
   and hit Run.
5. **Queue tab** for every other long-running job (downloads, extracts, FTP).
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
| Chiaki sidecar           | 9555 | TCP   | bound to `127.0.0.1`                 |
| PS5 payload LUA          | 9026 | TCP   | on the PS5                           |
| PS5 payload ELF          | 9021 | TCP   | on the PS5                           |

## Persistent Storage

```
./data/
  payloads.db    # SQLite (profiles, payloads, sequences, scripts, settings)
  payloads/      # uploaded/downloaded payload files
```

Backup & restore the whole thing as a ZIP from **Settings → Backup**.

## Tech Stack

- **Backend:** Node.js 20 + Express, native UDP (`dgram`) for PS5 discovery /
  WoL / pair, `sql.js` SQLite, `basic-ftp` for resilient FTP, `child_process`
  spawn for 7z / unrar / mkpfs / smbclient
- **Frontend:** React 18 + Vite, PWA with offline service worker
- **Chiaki sidecar:** Python 3.11 + FastAPI + `pyremoteplay` (PSN OAuth,
  registration, Remote Play session, DualSense input emulation)
- **Database:** SQLite (sql.js) persisted on a Docker volume

## Platform

- Linux / macOS / Windows with Docker (host networking required)
- Tested on Debian (dietpi) and Raspberry Pi-class hardware

## License

MIT
