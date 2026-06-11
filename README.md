# P5 Manager

<img src="frontend/public/icon-192.svg" alt="P5 Manager" width="80" align="left" />

A self-hosted web console for PS4 / PS5 homebrew: payload delivery, file
ops, image conversion, Remote Play and autoload sequences from one
browser tab.

<br clear="left" />

![status](https://img.shields.io/badge/status-active-success)
![platform](https://img.shields.io/badge/platform-Docker-blue)
![runtime](https://img.shields.io/badge/runtime-Node%2020%20%2B%20Python%203.11-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

---

## Features

**Remote Play** — One-click Wake (WoL + DDP LAUNCH + RP session), warm
session cache, rest-mode from the browser, on-screen DualShock, scripted
input DSL, sub-tabbed pair wizard (PSN-activated → Auto-fetch PIN;
not-activated → `offact.elf` registry push), LAN discovery for both
consoles.

**File Ops** — Browser over local / SMB / console FTP with cut/copy/paste,
rename, info, graphical folder picker. HTTP & torrent downloader.
Resilient FTP upload with TCP keep-alive + auto-resume. Multi-source
side-by-side view.

**Convert** — Unified converter with four pack modes
(`File`/`Folder` × `.ffpfsc`/`.exfat`). PFS path uses `mkpfs`; exFAT
path uses `mkfs.exfat` + loop mount + rsync. Unpack via the File
Browser kebab menu. PS4 `.pkg` unpack via flatz's `unpkg.py` renders
inline when the platform mode includes PS4.

**Tasks** — Single queue listing downloads, extracts, converts,
FTP uploads, PFS / PKG pack-unpack, exFAT pack/unpack and PKG
installs. Per-job start / pause / resume / retry / cancel.
Dedicated install sub-queue for fake PKGs on PS5
(`sceAppInstUtilInstallByPackage` via the vendored `pkg-install.elf`).
Queue state persists across container restarts.

**Payloads** — Direct GitHub fetch (release, tag, blob, raw),
`.lua` / `.elf` / `.bin` / `.zip` upload, automatic platform + port
detection, bundled default payloads with separate Check / Update
buttons. Files dropped into `data/payloads/` show up immediately.

**Autoload** — Step builder (`wait`, WoL, port-check, send payload,
download, extract, convert, FTP upload, RP session start/stop, input
script via RP). Platform-aware templates. Profile optional for non-
console sequences.

**Logs** — UDP LUA log server (`:8080`) and TCP kernel log server
(`:3232`) stream straight to the browser.

**Other** — Multiple PS5 profiles with auto-default + backup/restore
ZIP. Global FTP upload target shared across File Browser, Convert and
Autoload. Mobile-friendly responsive UI.

---

## Requirements

- PS5 firmware **≤ 12.70** for the LUA exploit chain (y2jb)
- A Lua-vulnerable game (~24 known titles, e.g. *Star Wars Racer
  Revenge* CUSA03474 / CUSA03492) or the y2jb harness
- Console reachable on the same LAN
- Docker + Docker Compose

---

## Install

```bash
git clone https://github.com/psdeviant/p5-manager.git
cd p5-manager
docker compose up -d --build
```

Web UI: `http://<host>:3001`.

Two containers come up, both on `network_mode: host` so PS5 discovery,
WoL and Remote Play work without port forwarding:

| Service        | Purpose                                                      |
|----------------|--------------------------------------------------------------|
| `app`          | Node/Express backend + bundled React frontend                |
| `pyremoteplay` | FastAPI sidecar wrapping `pyremoteplay` for OAuth + RP input |

Update with `git pull && docker compose up -d --build`. State lives in
`./data/` (SQLite DB, payloads, downloads, mkpfs scratch) and survives
rebuilds.

---

## Usage

1. **Settings → Profiles**: add a PS5 (IP + MAC).
2. **Payloads → ✨ Defaults**: pull the bundled community payloads.
3. **P5 Control**: pair Remote Play once (PSN-activated path is
   single-click via Auto-fetch PIN), then **Wake** opens an RP session
   ready for input.

The Convert, Autoload, Tasks and Logs tabs are self-explanatory from
there. See [`docker-compose.yml`](docker-compose.yml) for capability
notes (the exFAT pipeline needs `CAP_SYS_ADMIN` + relaxed
seccomp/AppArmor + `/dev/loopN` passthrough; all baked into the shipped
compose file).

---

## Default Ports

| Port | Proto | What                                       |
|------|-------|--------------------------------------------|
| 3001 | TCP   | Web UI + REST API                          |
| 9555 | TCP   | pyremoteplay sidecar (`127.0.0.1` only)    |
| 8080 | UDP   | LUA log server                             |
| 3232 | TCP   | Kernel log server                          |
| 9026 | TCP   | PS5 LUA payload (on console)               |
| 9021 | TCP   | PS5 ELF payload (on console)               |
| 9020 | TCP   | PS4 GoldHEN payload (on console)           |
| 2121 | TCP   | PS4 GoldHEN FTP (after `ftp_server.bin`)   |
| 9295 | UDP   | Remote Play DDP discovery + wake           |
| 9296 | UDP   | Remote Play control                        |

---

## Vendored PS5 Payloads

Source for the in-tree ELFs lives under [`p5managerclient/`](p5managerclient/)
and builds against the [ps5-payload-dev SDK](https://github.com/ps5-payload-dev/sdk):

| Payload          | Purpose                                                    |
|------------------|------------------------------------------------------------|
| `rp-get-pin.elf` | `sceRemoteplayGeneratePinCode` + foreground-user regmgr    |
| `offact.elf`     | Push OAuth-linked PSN `account_id` onto the console        |
| `pkg-install.elf`| `sceAppInstUtilInstallByPackage` for staged fake PKGs      |

Pre-built copies ship under **Payloads → ✨ Defaults**.

---

## Architecture

- **Backend** — Node.js 20, Express, native UDP for discovery / WoL /
  pair, `sql.js`, `basic-ftp`, spawns `mkpfs` / `mkfs.exfat` / `7z` /
  `smbclient`.
- **Frontend** — React 18 + Vite, PWA with offline service worker.
- **Sidecar** — Python 3.11 + FastAPI + [`pyremoteplay`](https://github.com/ktnrg45/pyremoteplay)
  (PSN OAuth, registration, RP session, DualShock emulation) with
  upstream timeout-predicate patches for clean standby + reconnect.
- **Storage** — SQLite (`sql.js`) on a bind-mounted Docker volume.

---

## Development

For working on the source itself only — not a substitute for the
Docker install. Bare-metal Node runs skip the sudoers + capability
plumbing the exFAT pipeline depends on.

```bash
cd backend  && npm install && npm run dev   # :3001
cd frontend && npm install && npm run dev   # :3000
cd pyremoteplay && pip install -r requirements.txt && python server.py
```

---

## Credits

This project glues together a lot of independent scene work. Star their
repos:

- [PSBrew / MkPFS](https://github.com/PSBrew/MkPFS) — `mkpfs`,
  PFS packer/unpacker driving the `.ffpfsc` modes
- [PSBrew / MicroMount](https://github.com/PSBrew/MicroMount) — bundled
  MicroMount payload + config editor
- [kerrdec97 / ps5-exfat-builder](https://github.com/kerrdec97/ps5-exfat-builder)
  — Windows-side reference for the exFAT image pipeline
- [ps5-payload-dev / sdk](https://github.com/ps5-payload-dev/sdk) —
  SDK every in-tree PS5 ELF builds against
- [ktnrg45 / pyremoteplay](https://github.com/ktnrg45/pyremoteplay) —
  Remote Play protocol library powering the sidecar
- [gezine](https://github.com/gezine) — author of **y2jb**, the PS5
  Lua-port jailbreak (PS5 fw ≤ 12.70, subject to upstream)
- **flatz** + **CelesteBlue** — original public-domain `unpkg.py` and
  the Python 3 port vendored as `backend/src/lib/unpkg.py`
- **etaHEN team** — PS5 jailbreak payload
- **GoldHEN team** (sleirsgoevy et al.) — PS4 GoldHEN payload

If you should be credited and aren't, please open an issue.

---

## License

MIT
