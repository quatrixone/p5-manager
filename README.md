# P5 Manager

<img src="frontend/public/icon-192.svg" alt="P5 Manager" width="80" align="left" />

A web app for managing a PS4 or PS5 that runs homebrew. Send payloads, move
and convert files, browse the installed library and use Remote Play, all
from one browser tab on your PC or phone.

<br clear="left" />

> Independent hobby project, not affiliated with or endorsed by Sony
> Interactive Entertainment. For use with a console you own and files you
> have the right to use. See [LEGAL.md](LEGAL.md).

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/runs%20on-Docker%20%7C%20Windows-blue)

![Library](docs/screenshots/library.png)

---

## Contents

- [What it does](#what-it-does)
- [Screenshots](#screenshots)
- [What you need](#what-you-need)
- [Install](#install)
- [First steps](#first-steps)
- [Ports](#ports)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [Credits](#credits)
- [Legal](#legal)

---

## What it does

| Tab | What you can do there |
|-----|-----------------------|
| **Payloads** | Keep a library of payloads (`.elf`, `.lua`, `.bin`), fetch them from a GitHub release, check for updates and send one to the console with a click. |
| **Autoload** | Build a sequence of steps (wake the console, wait for a port, send a payload, download, extract, convert, upload) and run it as one action. |
| **File Ops** | Browse this computer, a network share and the console side by side. Drag files between two panes to copy or move them, upload from your device, download from a URL, convert and extract. Long jobs run in a queue you can pause and resume. |
| **Library** | See every title ShadowMountPlus knows on the console, with icon, size and the drive it is on. Mount, move, copy, unpack, uninstall or delete a title, with a progress bar for the long ones. |
| **Console** | Remote Play in the browser: wake the console, see the screen, use an on-screen controller, record and replay button sequences, send a payload without leaving the view. |
| **Logs** | Live log streams from the console. |
| **Settings** | Console profiles, backup and restore, defaults, restart. |

Highlights:

- **Two-pane file manager.** Console on one side, your disk on the other
  (or the console on both). Transfers run on the server, so you can close
  the browser.
- **Convert on the console.** Start
  [PS5 Game Compressor](https://github.com/juma-sayeh/PS5-Game-Compressor)
  from the Convert tab and use it inside the app. Nothing is copied to the
  server.
- **Convert on the server.** Pack a file or folder into `.ffpfsc` (via
  `mkpfs`) or `.exfat`, and unpack them again.
- **Works on a phone.** The layout adapts to small screens and can be
  installed as an app (PWA).

---

## Screenshots

| File manager with two panes | A title in the Library |
|---|---|
| ![File Ops](docs/screenshots/file-ops-two-panes.png) | ![Library title](docs/screenshots/library-game.png) |

| Convert | Library on a phone |
|---|---|
| ![Convert](docs/screenshots/convert.png) | <img src="docs/screenshots/library-phone.png" alt="Library on a phone" width="260" /> |

The screenshots use made-up demo data.

---

## What you need

- A PS4 or PS5 that already runs homebrew, on the same network as the
  computer running P5 Manager. P5 Manager does not unlock a console.
- For the **Library** tab:
  [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) running on
  the console.
- For browsing the console's files: an FTP payload such as
  [zftpd](https://github.com/seregonwar/zftpd). P5 Manager starts it for
  you if it is in your payload library.
- One of:
  - **Docker** on Linux (recommended, all features), or
  - **Windows 10 / 11** for the portable version (no Docker needed).

---

## Install

### Docker

```bash
git clone https://github.com/quatrixone/p5-manager.git
cd p5-manager
docker compose up -d
```

Open `http://<this-computer>:3001`.

`docker compose up -d` pulls the published images. To build from source
instead, run `docker compose up -d --build`.

Two containers start, both with host networking so console discovery,
wake-on-LAN and Remote Play work without port forwarding:

| Service        | What it is                                             |
|----------------|--------------------------------------------------------|
| `app`          | The web app and its API                                |
| `pyremoteplay` | The Remote Play service the app talks to               |

Your data (database, payloads, downloads, conversion work files) lives in
`./data/` and survives updates. To update: `git pull && docker compose pull
&& docker compose up -d`.

### Windows (portable)

1. Download `P5Manager-windows-x64.zip` from the
   [latest release](https://github.com/quatrixone/p5-manager/releases/latest).
2. Extract the whole zip anywhere.
3. Double-click `P5Manager.exe`. A console window opens (that is the app)
   and your browser opens `http://localhost:3001/`.

Allow `node.exe` and `python.exe` through Windows Firewall on private
networks when asked. Your data is kept in the `data` folder next to the
exe. Close the console window to stop the app.

Two things work only in the Docker version: creating exFAT images, and
"remote source" SMB shares (on Windows, type the `\\server\share` path
into the Local file browser instead).

---

## First steps

1. **Settings → Profiles**: add your console (name and IP address).
2. **Payloads → Defaults**: fetch the payloads you use.
3. **File Ops → Browse**: turn on **Two panes**, pick *Local* on one side
   and *PS5 FTP* on the other, and drag a file across.
4. **Library**: pick the console. If ShadowMountPlus is not running, the
   page offers to start it.
5. **Console**: pair Remote Play once, then use **Wake** to open a session.

---

## Ports

| Port | Proto | What                                        |
|------|-------|---------------------------------------------|
| 3001 | TCP   | Web app and API                             |
| 9555 | TCP   | Remote Play service (`127.0.0.1` only)      |
| 8080 | UDP   | Log receiver                                |
| 3232 | TCP   | Kernel log receiver                         |
| 9295 | UDP   | Remote Play discovery and wake              |
| 9296 | UDP   | Remote Play control                         |

On the console, P5 Manager connects to the payload loader (9021 / 9026 on
PS5, 9020 on PS4), FTP (2120 or 2121), ShadowMountPlus (10101) and PS5 Game
Compressor (5910).

---

## How it is built

- **Backend**: Node.js and Express, SQLite through `sql.js`, `basic-ftp`.
  It calls `mkpfs`, `mkfs.exfat`, `7z` and `smbclient` for conversions and
  network shares.
- **Frontend**: React 18 and Vite, installable as a PWA.
- **Remote Play service**: Python 3.11, FastAPI and
  [`pyremoteplay`](https://github.com/ktnrg45/pyremoteplay).
- **Windows build**: the same code with a private Node and Python runtime
  and a small launcher, built and tested by
  [GitHub Actions](.github/workflows/windows-portable.yml).

Three small payloads written for this project live under
[`p5managerclient/`](p5managerclient/) and build with the
[ps5-payload-dev SDK](https://github.com/ps5-payload-dev/sdk):
`rp-get-pin.elf` (Remote Play pairing PIN), `offact.elf` (account ID for
Remote Play pairing) and `pkg-install.elf` (package install queue).

---

## Development

```bash
cd backend  && npm install && npm run dev   # API on :3001
cd frontend && npm install && npm run dev   # UI on :3000
cd pyremoteplay && pip install -r requirements.txt && python server.py
```

Tests: `npm test` in `backend/` and in `frontend/`. An end-to-end check
against a running instance: `node scripts/smoke.mjs http://127.0.0.1:3001
/tmp/p5m-smoke`.

Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md)
first.

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
- [gezine](https://github.com/gezine) — author of **y2jb**
- **flatz** + **CelesteBlue** — original public-domain `unpkg.py` and
  the Python 3 port vendored as `backend/src/lib/unpkg.py`
- **etaHEN team** — etaHEN
- **GoldHEN team** (sleirsgoevy et al.) — PS4 GoldHEN payload
- [drakmor / ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) —
  the API behind the Library tab
- [seregonwar / zftpd](https://github.com/seregonwar/zftpd) — FTP server
  and on-console downloader used by File Ops and Download
- [juma-sayeh / PS5-Game-Compressor](https://github.com/juma-sayeh/PS5-Game-Compressor)
  — on-console compression, started from the Convert tab

If you should be credited and aren't, please open an issue.

---

---

## Legal

Not affiliated with Sony Interactive Entertainment; "PlayStation", "PS4"
and "PS5" are its trademarks. This repository contains no Sony code,
firmware or keys and no game content, and third-party tools are fetched
from their authors rather than redistributed here. The project does not
support piracy. Details, intended use and how to report a content problem:
[LEGAL.md](LEGAL.md).

## License

[MIT](LICENSE)
