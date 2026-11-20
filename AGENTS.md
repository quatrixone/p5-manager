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

## Converting on the console: PS5 Dump Forge

The console converter is `p5managerclient/forge/ps5-dump-forge.elf`, taken
unchanged from its own release and pinned by checksum in
`backend/src/routes/forge.js` and `backend/src/lib/defaultPayloads.js`. Send
it with `POST /api/forge/<ip>/start`; it serves a REST API on 8095 and the
app reaches it through one guarded pass-through,
`ALL /api/forge/<ip>/api/<endpoint>`, which forwards JSON bodies and allows
only the endpoints the app uses. `quit` is ours alone (`/stop`, with
`if_idle`), and the debug build's `set`, `bench` and `crash` are refused -
`crash` kills the running game by design.

It reads the drives itself, so ShadowMountPlus is not needed to convert;
mounting a title is still ours (`/api/library/<ip>/games/<id>/mount`).
Switching the mount between two copies of one title through
`refresh-mount` does not work - unmount, then mount, and ShadowMountPlus
picks the surviving copy up.

The same program runs on this machine for host conversions: the `forge`
convert mode in `routes/convert.js`, with the CLI fetched once into
`<DATA_DIR>/tools` (checksum from the release; `USER_DATA_DIR` is a bind
mount we may not create folders in). Its flags come off `convert --help`:
`--to lz4` and `--lz4-pack` are alternatives, `--level` belongs to .ffpfsc
and `--kraken` to .pkg. An output name over 63 bytes (58 for .ffpfsc) cannot
be mounted by ShadowMountPlus, and Forge refuses it.

A target is a format plus flags, so packs are never a dead end: a source
holding LZ4 or zstd packs is taken apart on the way by `zstd_unpack` or
`lz4: unpack` in the same request. Every job is verified against its source
and the checks are in the job's report; `--full-verify` re-reads every byte.

**Before changing anything about a pack format, check it with the other
implementation.** An evening went into "the runtime cannot serve packed
reads" when the real fault was ours: the zstd volume header's CRC covers all
64 bytes with the CRC field zeroed, not the first 60, and our writer and our
test agreed on the same misreading. Forge's reader found it in a minute:

```bash
ps5-dump-forge convert <packed-tree> --to folder --zstd-unpack -o /tmp/out
```

It wants a game-shaped tree (`eboot.bin`, `sce_sys/param.json`), and
`inspect --json` reports `zstd_packed`.
