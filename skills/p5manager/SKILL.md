---
name: p5manager
description: Operate P5 Manager (the self-hosted PS4/PS5 homebrew console at http://192.168.1.10:3001) from an agent - check console discovery, start and stop Remote Play sessions, read screen frames, send controller buttons, deliver payloads, and read logs. Use with the ps5-control skill when a task touches the P5 Manager web API or its Remote Play sidecar.
---

# P5 Manager agent guide

P5 Manager is a two-container stack: Node/Express backend (port 3001) and a Python
pyremoteplay sidecar (port 9555, used for Remote Play). Source: `quatrixone/p5-manager`.
The base URL is `P5_MANAGER` (default `http://192.168.1.10:3001`).

For direct console control (payload port, FTP, shsrv shell, klog) use the **ps5-control**
skill. P5 Manager is for Remote Play and its own API.

## Routes an agent uses

All under `/api`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/remoteplay/discover?ip=IP` | console status (`status: Ok`, `running_app`) |
| GET | `/remoteplay/health` | sidecar health |
| POST | `/remoteplay/sessions/start` | body `{ip, profile_id, enable_video, resolution}`; resolution values come from the UI bundle (e.g. `"720p"`). Returns `session_id` |
| GET | `/remoteplay/sessions/:sid/video.mjpeg` | MJPEG stream; take the first `\xff\xd8 … \xff\xd9` frame for a screenshot |
| POST | `/remoteplay/sessions/:sid/input` | body `{button}`: `up down left right cross circle triangle square ps options` |
| POST | `/remoteplay/sessions/:sid/stop` | end the session |
| POST | `/remoteplay/quick-input` | send one button without a managed session (`{ip, button, action, duration_ms}`) |
| POST | `/ps5control/input` | same as quick-input, via the legacy ScriptRunner route |
| GET | `/ps5control/status`, `/ps5control/scan`, `/ps5control/arp` | network scan helpers |
| GET/POST | `/payloads`, `/payloads/send/:id`, `/payloads/send-raw` | stored payloads and raw send |

Note: `POST /remoteplay/sessions/start` returns a schema-like placeholder if the body is wrong.
Check the `resolution` value and `profile_id` before concluding the route is broken.

## Working rules

- Read the console screen before any confirming press (`cross`). Do not press blind.
- `ps` (power) and the power menu are off limits without explicit approval.
- A session started by one agent may still be in use; check `GET /remoteplay/discover` first.
- Remote Play sessions are a shared resource. Stop the session you started when done.

## Known gaps (as of 2026-10)

- Starting a title from the Remote Play session does not show if the title is registered
  or corrupted; read the on-screen error (e.g. "The data is corrupted", CE-108255-1) from a
  screenshot.
- Deleting a title through the API is not implemented for PS5 homebrew; use the console UI.
