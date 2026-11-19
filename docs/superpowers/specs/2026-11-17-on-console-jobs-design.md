# Work on the console: convert, download and extract, driven from P5 Manager

Date: 2026-11-17

## What this is for

When the user picks something on a console in File Ops, the work should
happen **on that console**, not on the server: converting, downloading and
unpacking. Today P5 Manager mostly pulls the data to the host, works on it
there and pushes it back, which costs host disk, host CPU and two trips over
the network for every byte.

Three things are wanted, in the user's own words: convert every type on the
console; copy straight from one console to the other, PS5→PS4 and back; and
when unpacking something that is on the console, unpack it there — zip and
rar included. The console-side engine is also two patch versions behind
upstream and should be updated.

Success: in File Ops, an action on a console path runs on the console, shows
its progress in P5 Manager, and survives the browser being closed. The host
stores nothing it does not have to.

## Where this starts from

- **The engine already exists.** `p5managerclient/p5converter/` is a
  vendored copy of theghostonline's PS5-LZ4-Compression (GPL-3.0). Its
  payload `lz4-compression.elf` serves a REST API on port 5920 with every
  conversion action: `games`, `compress`, `uncompress`, `lz4-pack`,
  `lz4-unpack`, `lz4-verify`, `validate-only`, `validate-repair`,
  `make-image`, `extract-image`, `copy-to-usb`, `copy-to-internal`,
  `move-to-usb`, `move-to-internal`, `build-ampr-index`, `update-ampr`,
  `set-read-only`, `refresh-mount`, `job`, `job/cancel`, `history`, `icon`,
  `usb`, `ui-settings`. Jobs keep running on the console when the client
  goes away.
- **P5 Manager only starts and stops it.** `routes/gamecompressor.js`
  installs the pinned ELF, sends it to the loader, polls ports and proxies
  the one shutdown call. The UI (`GameCompressor.jsx`) is an iframe pointed
  at the console's own web page, plus a link to open it in a tab.
- **Verified against upstream:** our vendored source is byte-identical to
  upstream v1.6.2 apart from a `.gitignore`, a trailing line in
  `gen-asset-module.py` and line endings in `third_party/qrcodegen`. We
  carry **no functional patches** — the different ELF checksum is only a
  local rebuild. Upstream's released v1.6.4 ELF is
  `a7c1a956ebddfc92851822b7d0e71e22fa98fd69758bc17b77043b338bd495a4`.
  1.6.3/1.6.4 fix `.exfat` / `.ffpfsc` files whose name has no title ID.
- **On-console downloading already works.** `routes/downloader.js` tells
  zftpd (1.6.0+ "zhttp" build) to fetch a URL itself through
  `/api/download/start|status|cancel`, and the Downloader tab has a "PS5"
  destination for it. The console in the loop currently runs an older zftpd
  (no HTTP API on the FTP port), so the payload needs updating.
- **Console→console already works, but through the host disk.** The
  dual-pane transfer queue (`/convert/transfer/queue`, `ftpUploadQ`) takes a
  console as source and a console as destination; the worker downloads each
  file to a temp file on the server, then uploads it. It needs free host
  space equal to the largest file and writes every byte to disk twice.
- **Archive extraction is host-side only.** `/convert/extract` stages the
  archive from the console to the host, unpacks it there and pushes the
  result back. Nothing on the console can unpack a zip or rar today. The
  engine does carry inflate code (`miniz_tinfl.c`, used by its app
  installer) but exposes no archive endpoint.
- The console in the loop is on firmware **13.60**, which is what upstream
  tests 1.6.4 against. `p5managerclient/sdk/` is present, so payload C code
  can be built here.

## Goals

1. Every conversion action the engine has is driven from P5 Manager's own
   UI, with our own progress and queue. No iframe.
2. A title in the Library can be converted from there: "Convert to…" next
   to Mount / Move to… / Copy to…, with the target format picked in the
   dialog. The Library is where the user already is when they think about a
   single title, so the action belongs there too, not only in Convert.
3. In File Ops, a download into a console folder is fetched by the console.
4. In File Ops, unpacking an archive that sits on a console happens on that
   console — zip and rar included.
5. Copying between two consoles streams, with nothing buffered on host disk.
6. The engine is on upstream 1.6.4, pinned by upstream's own checksum.

## Non-goals

- Replacing the engine's own web page or its console app. They stay; we just
  stop depending on them.
- Making our UI a superset of the engine's app (game reports, QR codes,
  donation screens, APR-EMU manifest browsing).
- PS4-side conversion. The engine is a PS5 payload; the PS4 keeps getting
  host-side treatment.
- Teaching the console to make HTTPS requests of its own beyond what zftpd
  already does.

## Anti-goals

Things that would make this a failure even if it technically worked:

- **Diverging from upstream.** We are byte-identical to upstream today and
  that is worth keeping: anything we add to the engine goes in its own file
  with its own endpoint prefix, so pulling upstream 1.6.5 stays a copy, not
  a merge.
- **A proxy that can reach anything.** The new pass-through must not become
  an open relay out of the server's network.
- **Losing jobs.** The engine's jobs outlive our page today. A P5 Manager
  restart must not orphan a running console job or show it as failed.
- **Pretending work is on the console when it is not.** If a path cannot be
  handled on the console, say so and let the user choose the host; never
  silently fall back.

## Constraints

- The engine's GPL-3.0 code stays separate from the MIT manager: vendored
  under `p5managerclient/` and `backend/third_party/`, pinned by checksum,
  never statically mixed into the Node app.
- RAR cannot use the UnRAR source — its licence is GPL-incompatible and the
  engine is GPL-3.0. libarchive (BSD, with clean-room RAR4 and RAR5 readers)
  is the one that can be linked.
- The engine needs ShadowMountPlus and kstuff-lite 1.07+ on the console; the
  status endpoint already reports both.
- An https:// P5 Manager cannot frame or fetch the console's http:// page
  from the browser, which is why everything goes through the backend.
- The engine serves one job at a time and keeps its own history; our UI
  follows that model instead of inventing a second queue.

## Approaches considered

**A. Put everything in our fork of the engine.** Add archive extraction and
a downloader to `lz4-compression.elf` and drive the lot from P5 Manager. One
payload, one job system, one progress source — the engine already has a web
server, a job queue, cancel, a power guard and history. Cost: C work for
every feature, and we lose the clean upstream relationship we were just
shown to have.

**B. Split: upstream engine untouched, our own agent for the rest.** Bump
the engine and only proxy it; put archive extraction in `p5managerd`
(today a 97 KB health-check stub). Upstream stays a pure copy. Cost: writing
a web server, job queue, progress and cancellation from scratch — all things
the engine already has — and three progress sources to unify in the UI.

**C. Staged, cheapest risk first.** Phase 1 takes everything that needs no C
code at all: a native UI over the engine's existing API, File Ops wired to
the console-side downloader, streaming console→console, engine at 1.6.4.
Phase 2 adds zip extraction to the engine (its inflate code is already in
the tree). Phase 3 adds rar via vendored libarchive.

**Chosen: C.** It delivers "the work happens on the console" for convert,
download and copy without touching C, and it puts the two expensive,
licence-sensitive and unproven pieces (libarchive building against the PS5
SDK at all) last, where they cannot block the rest. Phases 2 and 3 land as
new files with their own endpoint prefix, so the anti-goal above holds.

A deliberate limit of the choice, stated plainly: **console→console will not
be peer-to-peer.** The PS4 runs none of our payloads, so the bytes pass
through the host. Phase 1 makes that a stream rather than a staged copy —
one pass, no host disk — but the host stays in the path.

## Phase 1 — the design

### Engine bump

`routes/gamecompressor.js` pins `version: '1.6.2-p5manager'` and a local
checksum. Replace the vendored tree with upstream v1.6.4, vendor **upstream's
released ELF** and pin **upstream's** checksum, so the version we run is the
version upstream tested. Keep the local trivia (`.gitignore`); drop the
`-p5manager` suffix, since we carry nothing of our own. `backend/image-level`
does not change — the bundled payload is data, not a dependency.

### One pass-through, not twenty routes

A single proxy route under `gamecompressor.js`:

```
ALL /api/gamecompressor/:ip/engine/*  →  http://<ip>:5920/api/lzc/*
```

It forwards method, query and JSON body, and streams the answer back. Guard
rails, all enforced server-side:

- `:ip` must be a known profile's address, not any IP that parses.
- Only the fixed port 5920, only paths under `/api/lzc/` plus
  `/api/status`; no redirects followed.
- The console is asked to start the engine first (reuse `install()` +
  `sendElfPayload`) when port 5920 is closed, with the existing readable
  errors about ShadowMountPlus and kstuff.

This is what makes "convert every type" true without us modelling each
action: whatever the engine gains, our UI can call. The cost is that the
frontend speaks the engine's own request shapes — accepted, because those
shapes are visible in `src/lzc_api.c` and the engine is pinned by checksum,
so they cannot change under us without us noticing.

### The UI

`GameCompressor.jsx` loses the iframe and becomes a real panel, built from
the components already in the tree (`Modal`, `ProgressBar`, `Badge`,
`EmptyState`, `SearchSelect`, `PathField`):

- Console picker and engine state (installed / running / loader /
  ShadowMountPlus), with Start and Stop as today.
- The console's game list from `engine/games`, with the icon endpoint for
  thumbnails, filtered and searchable.
- Per title, the actions the engine offers for it, grouped the way the
  engine groups them: Compress (LZ4 pack, `.ffpfsc`), Check (verify,
  validate, repair), Restore (uncompress, in place or as a copy), Images
  (make / extract exFAT or PFS, read-only), Move (internal ↔ USB).
- The live job from `engine/job` with progress, speed and time left, a
  Cancel button, and the engine's `history` underneath.
- Polling is visibility-gated (`useVisiblePolling`), as everywhere else.

Settings that the engine takes per job (LZ4 level 1–12, profile, destination,
what happens to the original) are the job form's fields, with the engine's
own defaults preselected.

### Convert from the Library

The Library's title dialog already holds the per-title storage actions
(Mount, Move to…, Copy to…, Unpack to…, Rename, Uninstall, Delete). It
gains **Convert to…**, which opens the same action form the Convert panel
uses, scoped to that title: the format is picked there (LZ4 packs, `.ffpfsc`
with exFAT or PFS inside, or back to a plain folder), together with what
happens to the original.

Nothing new is built for it. The Library has both values the engine wants
(`title_id`, `path`), so the dialog renders the Convert panel's action
component with them. It is offered only for a PS5 profile, only when the
engine answers, and it is disabled while the engine reports a job in
flight — the engine runs one at a time.

### File Ops: download on the console

The console-side downloader exists; it is simply not reachable from the
place where the user is looking at a console folder. In the File Ops browser,
when the active pane is a console, offer "Download here" which posts to the
existing `/downloader` endpoint with `dest_kind: 'ps5'`, `ps5_ip` and the
browsed path. No new backend work beyond the error path: when zftpd has no
HTTP API, the message already says the 1.6.0+ zhttp build is needed, so add
the one-click "send the newer zftpd" the payload library can already do.

### File Ops: extract where the file is

`/convert/extract` learns one more decision, made in `validateExtractParams`
and surfaced by `/convert/extract/check`: when source and destination are
both on the same console, the job is a **console job**.

In phase 1 that covers what the engine can already do — `.exfat` / `.ffpfsc`
images via `extract-image`, and the `.pkg` path we already drive. Anything
else (zip, rar) still reports honestly that it will be unpacked on the host,
with the console option greyed out and a reason, until phase 2 and 3 land.
The queue item gains `where: 'console' | 'host'` so the Tasks list says
where each job is running.

### Console → console without the host disk

`fetchTransferSource()` downloads to a temp file and the worker then uploads
it. For a console→console item, replace that with one pipe: a `PassThrough`
between the source FTP's `downloadTo(stream)` and the destination FTP's
`uploadFrom(stream)`, two clients, no file. Keep every existing behaviour:
per-item progress from the source's byte counter, the move-only source
delete after the destination is verified, `removeEmptiedSourceDirs`, and the
`assertFreeSpace` check — which for a streamed item has nothing to check on
the host, so it applies to the destination only.

This also removes the host-disk requirement from PS5→PS4 and PS4→PS5 copies,
which is the "direct copying" the user asked for, as directly as the PS4
allows.

## Phase 2 — zip on the console

A new file in the engine (`lzc_archive.c`) and a new endpoint,
`POST /api/lzc/extract-archive`, taking an archive path, a destination and
the usual job semantics, so our existing `engine/job` polling shows it with
no UI change. Zip/deflate rides on the `miniz_tinfl.c` already vendored for
the app installer. The endpoint lives in its own file under its own name so
an upstream bump stays a copy.

File Ops then offers the console for `.zip` on a console path, and the
extract queue marks the item `where: 'console'`.

## Phase 3 — rar on the console

Vendor libarchive into the engine and let `extract-archive` take rar4, rar5,
7z and tar through it. Open question that must be answered before this is
promised to anyone: **whether libarchive builds against the PS5 payload SDK
at all.** That is a spike, not a task; if it fails, rar stays a host job and
File Ops keeps saying so.

## What is left to the builder

- Exact engine request bodies per action: read the handler in
  `src/lzc_api.c` and mirror the field names; do not invent a translation
  layer.
- How the native panel is laid out inside the existing Convert tab (its own
  card, or a sub-tab) — follow what the surrounding components do.
- Whether the engine's `history` is shown inline or behind a disclosure.
- Progress plumbing for a streamed console→console item: the source's
  `trackProgress` is the natural source of truth; confirm it fires for a
  stream download as it does for a file download.
- Test shape: unit tests for the proxy's allow-list and for the streaming
  transfer's error and move paths; the console actions themselves are
  checked by hand on the 13.60 console.

## Risks

- The engine is pinned by checksum, so a bump is a deliberate step; a 1.6.4
  ELF that misbehaves on this console is caught by keeping 1.6.2's checksum
  in git history and reverting the pin.
- Dropping the iframe means any engine feature we do not surface becomes
  unreachable from our UI. The pass-through keeps the escape hatch: the
  "open in a new tab" link stays.
- The engine runs one job at a time. Our UI must not let a user queue five
  console jobs and believe they are all running; the job form is disabled
  while `engine/job` reports one in flight.
