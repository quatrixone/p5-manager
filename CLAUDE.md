# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

P5 Manager is a self-hosted web console for PS4/PS5 homebrew: payload delivery, file ops, image conversion, Remote Play, and autoload sequences. Two-container Docker stack: Node/Express backend + Python FastAPI sidecar (Remote Play, on `p5rp` - a libchiaki helper in `rpnative/`, AGPL).

## Commands

```bash
# Full stack (Docker)
docker compose up -d --build

# Backend (port 3001)
cd backend && npm install && npm run dev

# Frontend (port 3000, proxies API to :3001)
cd frontend && npm install && npm run dev

# Frontend build
cd frontend && npm run build

# Python sidecar (Remote Play: pairing, wake, sessions). Needs p5rp:
cmake -S rpnative -B build-rp -G Ninja && cmake --build build-rp --target p5rp
cd remoteplay && pip install -r requirements.txt && P5RP_BIN=../build-rp/p5rp python server.py
```

## Architecture

### Backend (`backend/src/`)

- **App**: `main.js` — Express app, mounts all routers, auto-starts log servers
- **Database**: `db/sqlite.js` — sql.js (SQLite in-memory + file persistence). `DatabaseRepo` class provides `queryOne / queryAll / queryScalar / run / runAndSave`. `getRepo()` singleton.
- **Routes** (`routes/`): One file per resource. All follow `router.METHOD` pattern and use `getRepo()` for DB access.
- **JobQueue** (`lib/JobQueue.js`): Generic async queue with single in-flight worker. Handles pause/resume/retry/clear/move. Used for convert, extract, ftpUpload, install, download jobs. `mountQueueRoutes()` wires standard CRUD onto any router.
- **Remote Play**: `routes/remoteplay.js` proxies the sidecar (`remoteplay/server.py`; called `pyremoteplay` earlier). The sidecar runs one `p5rp` per session (`chiaki_engine.py`), finds/wakes consoles with `ddp.py` (PS5 port 9302, PS4 987) and signs in to PSN with `psn_oauth.py`. `lib/webrtc.js` turns the sidecar's `/sessions/:id/stream` (p5rp records: H.264 Annex B + Opus) into WebRTC tracks with node-datachannel; the frontend's `RemotePlayVideo.jsx` plays it and falls back to MJPEG.
- **Log servers**: `routes/logServer.js` (UDP :8080), `routes/kernelLogServer.js` (TCP :3232)
- **Autoload**: `routes/sequences.js` runs saved sequences and holds the watcher that starts a sequence by itself when its console is on but the loader port is closed (`auto_trigger = 'loader_down'`).
- **Entry and update**: `src/index.js` is a small loader that never changes through an in-app update; the app proper is `src/main.js`. `routes/update.js` reads the GitHub release tagged `updates`, downloads the newest app bundle for its platform (`scripts/build-app-bundle.mjs` builds one for Docker and one for the Windows package, which also carries `remoteplay/`; `.github/workflows/app-bundle.yml` publishes them there for every version tag, not in the version's own release), unpacks it into `<DATA_DIR>/app-update/current` and exits with code 75; the loader then runs that copy on the image's `node_modules`. Bump `backend/image-level` when a release needs a new image for reasons other than dependencies (those are fingerprinted by `backend/deps-hash.mjs`). `P5M_UPDATE_FEED` points the check at another URL for testing; `scripts/update-check.mjs` uses it to run a whole update against a local instance, as both workflows do.

### Frontend (`frontend/src/`)

- **API layer** (`lib/api.js`): Centralized fetch wrapper. `api.get/post/put/patch/del` + `apiSafe` variant that swallows errors. Auto-prepends `/api` prefix.
- **Contexts**: `contexts/PlatformContext.jsx` (platform mode PS4/PS5/auto for the whole tree), `contexts/Ps5StatusContext.jsx` (one shared console status poll).
- **Hooks**: `useApi.js` (fetch helper), `useVisiblePolling.js` (visibility-gated polling).
- **Components** (`components/`): One file per tab/section. `App.jsx` wires routing and global state.

### Data Model

Tables: `profiles`, `payloads`, `autoload_sequences`, `logs`, `settings`, `input_scripts`, `convert_sources`. Schema migrations are `ALTER TABLE ... ADD COLUMN` statements in `db/sqlite.js`, each wrapped in a try/catch that ignores "duplicate column".

### Key Patterns

- Backend route handlers catch their own errors and answer `res.status(...).json({ error })`; there is no shared error middleware.
- Frontend uses `apiSafe` for fire-and-forget polling and `api` for operations requiring error handling.
- exFAT pipeline (`lib/exfat.js`) requires `CAP_SYS_ADMIN` + loop device passthrough (handled in docker-compose.yml).

## Environment

- `PORT` — backend port (default 3001)
- `REMOTEPLAY_SIDECAR_URL` — sidecar URL (default http://127.0.0.1:9555); the sidecar itself takes `REMOTEPLAY_SIDECAR_HOST` / `REMOTEPLAY_SIDECAR_PORT` / `REMOTEPLAY_SIDECAR_LOG`
- `P5M_WEBRTC_PORTS` (`50000-50100`), `P5M_WEBRTC_ICE` (comma-separated STUN/TURN) — WebRTC to the browser
- `P5RP_BIN` — where the sidecar finds p5rp (else next to it or on the PATH)
- `DATA_DIR` — internal data directory (database; default /app/data in the image)
- `USER_DATA_DIR` — payloads, downloads and mkpfs work files (default /data)
- `NODE_ENV=production` — enables static file serving + PWA service worker
