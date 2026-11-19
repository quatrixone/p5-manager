# AGENTS.md

Notes for agents working on this repo against real hardware. Project
guidance lives in `CLAUDE.md`; this file is only about the console in the
loop. Keep console addresses, PSN names and account ids out of this file.

## Waking the console

Plain Wake-on-LAN (the ethernet magic packet) does **nothing** on a PS4 or
PS5. They wake from rest mode on a DDP `WAKEUP` packet (UDP 9302 on PS5,
987 on PS4) whose `user-credential` is derived from the Remote Play regist
key, so the console must already be paired.

The running backend does it for you — no need to hand-build the packet:

```bash
curl -s -X POST http://127.0.0.1:3001/api/remoteplay/wake \
  -H 'Content-Type: application/json' -d '{"profile_id":<id>}'
# {"ok":true,"on":true,"already_on":false,"packets_sent":2,"waited_s":49.1}
```

It powers the console on and nothing else - no account sign-in, no Remote
Play session - and it only answers once discovery reports the console as
"Ok", so there is nothing to poll. Budget up to 90 s; it raises a 502 after
that. (`backend/src/routes/remoteplay.js` → sidecar `/wake` →
`remoteplay/ddp.py`. Profile ids come from `GET /api/profiles`; that
response also carries PSN identity, so don't paste it anywhere.)

Measured on the PS5: 49 s and two wakeup packets from rest mode, 0.1 s when
it was already on. **A console that has just gone into rest mode ignores the
first wakeup packet** - it is still winding its services down - which is why
the call keeps nudging it every 30 s instead of firing one burst.

A freshly woken console sits on the "Press the PS button" user picker. That
is expected: signing the account in is part of starting a Remote Play
session (the sidecar sends DDP LAUNCH there), not part of waking.

What comes back by itself after a wake, and what does not:

| Port | Service | After wake |
|---|---|---|
| 9021 | ELF payload loader | up |
| 2120 | FTP (zftpd) | up |
| 10101 | ShadowMountPlus | up |
| 3232 / 2323 | klog / shsrv | down — send the payload |
| 5920 | P5 Converter engine | down — `POST /api/gamecompressor/<ip>/start` |

Rest mode is the safe way back: `POST /api/remoteplay/standby` (it reported
`Server Standby` within 5 s on this console). Don't reboot without asking.

A Remote Play session starts in ~3 s on a free console, but the first start
after a stop waits out the console's post-disconnect lock: 32 s measured.
Nothing is parked between sessions any more, so that cost is real - don't
read it as a hang.

## Gotchas

- `~/.claude/skills/ps5-control/scripts/ps5ctl.py status` throws
  `TypeError: catching classes that do not inherit from BaseException`
  (`except (ftplib.all_errors, OSError)` — `all_errors` is already a
  tuple). Probe the ports with `/dev/tcp` until that skill is fixed.
- The zftpd build on the console may be pre-1.6.0, with no HTTP API on the
  FTP port: a `curl` there fails with "Received HTTP/0.9 when not allowed".
  The on-console downloader (`routes/downloader.js`) needs the 1.6.0+
  "zhttp" build.
