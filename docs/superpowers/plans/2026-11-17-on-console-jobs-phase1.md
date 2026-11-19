# On-console jobs, phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive every conversion action of the console-side LZ4 Compression engine from P5 Manager's own UI — in the Convert panel and from a title in the Library — let the console fetch its own downloads from File Ops, stream console→console copies without touching host disk, and say honestly where each extract runs.

**Architecture:** One guarded pass-through route forwards `/api/gamecompressor/:ip/engine/*` to the engine's own REST API on port 5920, so no per-action backend code exists and the frontend speaks the engine's own request shapes. The iframe panel becomes a native panel built from existing UI components. The transfer worker gains a stream path for console→console items. No C code and no new dependency in this phase.

**Tech Stack:** Node 20 / Express 4, `basic-ftp`, React 18 + Vite, `node --test`, the vendored GPL engine payload (`p5managerclient/p5converter/`).

**Spec:** `docs/superpowers/specs/2026-11-17-on-console-jobs-design.md`

## Global Constraints

- The engine payload is pinned by checksum and is **upstream's own release
  binary**: `lz4-compression.elf` v1.6.4, sha256
  `a7c1a956ebddfc92851822b7d0e71e22fa98fd69758bc17b77043b338bd495a4`.
- The engine's GPL-3.0 code stays under `p5managerclient/` and
  `backend/third_party/`, pinned and never mixed into the MIT Node app.
- The engine port is fixed at **5920**; the proxy reaches nothing else.
- Only paths under `/api/lzc/` plus `/api/status` may be proxied; redirects
  are not followed.
- The engine runs **one job at a time** and answers `409 "action already
  running for this game"`; the UI must respect that instead of queueing.
- The console needs ShadowMountPlus and kstuff-lite 1.07+; the existing
  status endpoint already reports both and its error copy stays.
- `backend/image-level` is **not** bumped: the payload is data.
- Nothing in this phase adds a dependency to `backend/package.json`.

## Review Focus

1. **A proxy tail that escapes its prefix** (`/engine/lzc/../../../etc/passwd`,
   an absolute `//evil.host/x`, a URL-encoded `..%2f`): must be rejected, not
   normalised and forwarded. Covered in Task 2.
2. **An `:ip` that is not one of the user's consoles** (a LAN host, a public
   address): must be refused even though it parses as an IP. Covered in Task 2.
3. **The engine refusing an action with 409 while another job runs:** the
   panel must show the engine's message and leave the form usable, not spin
   forever. Covered in Task 3.
4. **A streamed console→console copy that breaks mid-file:** the partial file
   on the destination must be removed and the item must fail (it has no
   resume), with the source untouched for a move. Covered in Task 4.
5. **An archive that cannot be unpacked on the console in this phase** (zip,
   rar, 7z on a console path): File Ops must say the host will do it and why,
   never silently run it elsewhere than it claims. Covered in Task 6.

---

### Task 1: Engine on upstream 1.6.4

**Files:**
- Replace: `p5managerclient/p5converter/` (source tree and
  `lz4-compression.elf`, from upstream v1.6.4)
- Modify: `backend/src/routes/gamecompressor.js:12-17` (the `RELEASE` object)
- Modify: `backend/src/lib/defaultPayloads.js:23` (the `VENDORED_PAYLOADS`
  entry's `version`)
- Test: `backend/src/lib/vendoredEngine.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `RELEASE = { version: '1.6.4', filename: 'lz4-compression.elf',
  sha256: 'a7c1a9…' }` in `gamecompressor.js`, exported as before (it is
  module-local today; export it as `ENGINE_RELEASE` so the test can read the
  pinned value instead of hard-coding it twice).

- [ ] **Step 1: Write the failing test**

```js
// backend/src/lib/vendoredEngine.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ENGINE_RELEASE } from '../routes/gamecompressor.js';
import { VENDORED_PAYLOADS, vendoredSource } from './defaultPayloads.js';

test('the vendored engine is the pinned upstream release', () => {
  const source = vendoredSource(VENDORED_PAYLOADS.find(p => p.filename === ENGINE_RELEASE.filename));
  assert.ok(source, 'lz4-compression.elf is not vendored');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  assert.equal(sha, ENGINE_RELEASE.sha256);
  assert.equal(ENGINE_RELEASE.version, '1.6.4');
});

test('the payload library records the same engine version', () => {
  const entry = VENDORED_PAYLOADS.find(p => p.filename === 'lz4-compression.elf');
  assert.equal(entry.version, ENGINE_RELEASE.version);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npm test -- --test-name-pattern="vendored engine"`
Expected: FAIL — the vendored ELF is the local 1.6.2 build
(`92b1ba54…`), and `ENGINE_RELEASE` is not exported yet.

- [ ] **Step 3: Vendor upstream v1.6.4**

Download `lz4-compression.elf` and the source archive of tag `v1.6.4` from
`https://theghostonline.dev/theghostonline/PS5-LZ4-Compression`, verify the
ELF against the release's `SHA256SUMS`, and replace the contents of
`p5managerclient/p5converter/` with the upstream tree plus that ELF.
Keep the local `.gitignore`. Do not keep a local rebuild: the pinned
checksum is upstream's.

- [ ] **Step 4: Update the two version sites**

`export const ENGINE_RELEASE` in `backend/src/routes/gamecompressor.js` with
version `1.6.4` and the upstream sha256 (keep the module-local `RELEASE`
reference working by assigning from it), and the `version` of the
`lz4-compression.elf` entry in `VENDORED_PAYLOADS`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npm test`
Expected: PASS, 166 tests.

- [ ] **Step 6: Commit**

```bash
git add p5managerclient/p5converter backend/src/routes/gamecompressor.js \
        backend/src/lib/defaultPayloads.js backend/src/lib/vendoredEngine.test.js
git commit -m "Run the console engine upstream ships, 1.6.4"
```

---

### Task 2: The guarded engine pass-through

**Files:**
- Create: `backend/src/lib/engineProxy.js`
- Create: `backend/src/lib/engineProxy.test.js`
- Modify: `backend/src/routes/gamecompressor.js` (add the route)

**Interfaces:**
- Consumes: `ENGINE_RELEASE`, `install()`, `sendElfPayload`, `tcpPortOpen`
  from `gamecompressor.js` / `convert.js` as they are used today.
- Produces:
  - `ENGINE_PORT = 5920`
  - `engineUrl(ip: string, tail: string, search: string): string` — builds
    `http://<ip>:5920/api/<tail><search>`; throws `Error` with a readable
    message when `ip` is not an IP address or `tail` is not allowed.
  - Route `ALL /api/gamecompressor/:ip/engine/*` on the existing router.

- [ ] **Step 1: Write the failing test**

```js
// backend/src/lib/engineProxy.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { engineUrl, ENGINE_PORT } from './engineProxy.js';

test('builds a url for an engine path', () => {
  assert.equal(engineUrl('192.0.2.5', 'lzc/games', ''), `http://192.0.2.5:${ENGINE_PORT}/api/lzc/games`);
  assert.equal(engineUrl('192.0.2.5', 'lzc/compress', '?titleId=PPSA01234&format=exfat'),
    `http://192.0.2.5:${ENGINE_PORT}/api/lzc/compress?titleId=PPSA01234&format=exfat`);
  assert.equal(engineUrl('192.0.2.5', 'status', ''), `http://192.0.2.5:${ENGINE_PORT}/api/status`);
});

test('refuses anything that is not an engine path', () => {
  for (const tail of ['lzc/../../etc/passwd', '..%2f..%2fetc', '/lzc/games', 'lzc//evil.host/x',
                      'control/shutdown', 'other', 'lzc/games?x=1', 'lzc/' + 'a'.repeat(300)]) {
    assert.throws(() => engineUrl('192.0.2.5', tail, ''), /not an engine path/i, tail);
  }
});

test('refuses an address that is not an IP', () => {
  for (const ip of ['evil.host', '192.0.2.5:80', '', '192.0.2.5/x']) {
    assert.throws(() => engineUrl(ip, 'lzc/games', ''), /console address/i, ip);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npm test -- --test-name-pattern="engine"`
Expected: FAIL — `engineProxy.js` does not exist.

- [ ] **Step 3: Implement `engineUrl` in `backend/src/lib/engineProxy.js`**

Validate with `net.isIP`. Accept a tail matching
`/^(status|lzc\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?)$/` and at most 64
characters — decode nothing, normalise nothing, reject everything else with
`not an engine path`. The query string is passed through verbatim because
the engine reads all job parameters as query args (`titleId`, `sourcePath`,
`format`, `mode`, `destination`, `deletePolicy`, `preserveOriginal`,
`usbId`, `level`, `profile`).

- [ ] **Step 4: Run the tests**

Run: `cd backend && npm test -- --test-name-pattern="engine"`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Follow the router-poking pattern of `src/routes/remoteplayIdentity.test.js`
(temp `P5M_DB_DIR`, `initDatabase()`, then reach into `router.stack`), in a
new `backend/src/routes/gamecompressorProxy.test.js`:

```js
test('the proxy refuses a console that is not a profile', async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true }; };
  const res = await callProxy({ params: { ip: '203.0.113.9', 0: 'lzc/games' }, method: 'GET', query: {} });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /203\.0\.113\.9/);
  assert.equal(fetched, false, 'nothing may be fetched for an unknown console');
});

test('the proxy refuses a path outside the engine API', async () => {
  getRepo().runAndSave('INSERT INTO profiles (name, ip_address, console_type) VALUES (?, ?, ?)',
    ['t', '192.0.2.5', 'ps5']);
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true }; };
  const res = await callProxy({ params: { ip: '192.0.2.5', 0: 'control/shutdown' }, method: 'POST', query: {} });
  assert.equal(res.status, 400);
  assert.equal(fetched, false);
});
```

- [ ] **Step 6: Implement the route in `gamecompressor.js`**

`router.all('/:ip/engine/*', …)`:
1. `:ip` must belong to a profile — `getRepo().queryOne('SELECT id FROM
   profiles WHERE ip_address = ? LIMIT 1', [ip])`; otherwise 404 "No console
   with that address is set up in P5 Manager".
2. Build the target with `engineUrl(ip, req.params[0], qs)`; a thrown error
   is a 400.
3. When port 5920 is closed, run the same start path `POST /:ip/start`
   uses (`install()` + `sendElfPayload` + the readable 409/504 messages), so
   the first action from a cold console starts the engine.
4. `fetch` with `redirect: 'manual'`, a 10 s timeout for GETs and 60 s for
   POSTs, forward the upstream status, copy `content-type`, and stream the
   body through (the engine serves PNG icons as well as JSON).
5. On a network error answer 502 "LZ4 Compression is not reachable on
   <ip>:5920".

- [ ] **Step 7: Run the tests**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/lib/engineProxy.js backend/src/lib/engineProxy.test.js \
        backend/src/routes/gamecompressor.js
git commit -m "Reach the console engine's own API through P5 Manager"
```

---

### Task 3: The native console-convert panel

**Files:**
- Rewrite: `frontend/src/components/GameCompressor.jsx`
- Create: `frontend/src/components/ConsoleGameActions.jsx`
- Modify: `frontend/src/components/Convert.jsx` (only if the panel's props
  change)

**Interfaces:**
- Consumes: the Task 2 route, through the existing `api` helper:
  `api.get('/gamecompressor/<ip>/engine/lzc/games')`,
  `…/engine/lzc/job`, `…/engine/lzc/history`,
  `api.post('/gamecompressor/<ip>/engine/lzc/job/cancel')`,
  `api.post('/gamecompressor/<ip>/engine/lzc/<action>?<args>')`, and
  `/api/gamecompressor/<ip>/engine/lzc/icon?titleId=<id>&size=thumb` as an
  `<img src>`.
- Produces: `ConsoleGameActions({ ip, game, busy, onStarted, onError })` —
  the per-title action form; it owns which actions a game is offered and
  the arguments each one sends.

Engine field names this task reads (from `src/lzc_api.c`, do not rename):
- a game: `titleId`, `name`, `sourcePath`, `sourceKind`, `storage`,
  `sourceSize`, `compressedSize`, `savedBytes`, `freeBytes`,
  `requiredBytes`, `primaryAction`, `validation`, `aprIndexed`,
  `amprVersion`, `amprLatestVersion`, `mountStatus`, `instanceId`.
- the job: `busy`, `verb`, `current`, `phase`, `phaseStep`, `phaseCount`,
  `totalBytes`, `copiedBytes`, `speedBytesPerSec`, `elapsedSeconds`,
  `cancelDisabled`, `cancelDisabledReason`, `cancelRequested`, `error`,
  `activeId`.

- [ ] **Step 1: Replace the iframe with the panel**

Keep the card's lifecycle half as it is (console picker, status badge,
Start, Stop, the GPL attribution line, the "open in a new tab" link as the
escape hatch) and drop the `<iframe>` and the `embed` / `canEmbed` state.
Below it render: the game list from `engine/lzc/games` with icons, name,
storage, size and saved bytes, searchable with the existing
`SearchSelect`-style input; the live job from `engine/lzc/job` in a
`ProgressBar` with verb, phase (`phaseStep`/`phaseCount`), speed and
elapsed time plus a Cancel button that is disabled when `cancelDisabled`
(show `cancelDisabledReason` as its title); and the engine's `history`
under a disclosure. Poll `job` every 2 s and `games` every 15 s with
`useVisiblePolling`, only while the card is open and the engine is running.

- [ ] **Step 2: Implement `ConsoleGameActions.jsx`**

The main button is the engine's own `primaryAction` for that game. Under
"More" offer the engine's groups, each posting to the matching endpoint
with its arguments: Compress (`lzc/lz4-pack` with `level`, `profile`;
`lzc/compress` with `format=exfat|pfs`, `destination`, `deletePolicy`),
Check (`lzc/lz4-verify`, `lzc/validate-only`, `lzc/validate-repair`),
Restore (`lzc/lz4-unpack`, `lzc/uncompress` with `mode=image|folder`),
Images (`lzc/make-image`, `lzc/extract-image`, `lzc/set-read-only`),
APR-EMU (`lzc/build-ampr-index`, `lzc/update-ampr`,
`lzc/restore-ampr-original`), Move (`lzc/copy-to-usb`,
`lzc/move-to-usb`, `lzc/copy-to-internal`, `lzc/move-to-internal`, with
`usbId` from `engine/lzc/usb`). Every call carries `titleId` and
`sourcePath` from the game. Preselect the engine's defaults (LZ4 level 9,
`format=exfat`, `profile=automatic`, `deletePolicy=after`).

- [ ] **Step 3: Handle the engine's refusals (Review Focus 3)**

While `job.busy` is true, disable the action buttons and say which title is
running. A 409 from an action is shown as the engine's own message next to
the form and leaves the form enabled; the panel does not retry it.

- [ ] **Step 4: Verify the build**

Run: `cd frontend && npm run build`
Expected: builds with no new warnings.

- [ ] **Step 5: Check it on the console by hand**

With the console on: open Convert → Convert on console, start the engine,
confirm the game list and icons appear, start a `validate-only` on one
title, watch progress move, cancel it, and see it in history. Note the
engine needs ShadowMountPlus running.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/GameCompressor.jsx frontend/src/components/ConsoleGameActions.jsx
git commit -m "Run console conversions from P5 Manager's own screen"
```

---

### Task 4: Console→console copies stream, with no host disk

**Files:**
- Modify: `backend/src/routes/convert.js` — `executeFtpUploadJob`
  (around 4212-4290) and a new `streamConsoleToConsole()` beside
  `fetchTransferSource` (4123)
- Test: `backend/src/lib/transferStream.test.js` (create), with the pure
  decision extracted to `backend/src/lib/transferStream.js`

**Interfaces:**
- Consumes: `withFtp`, `loadFtp`, `joinPath`, `appendFtpJobLog` as used
  today.
- Produces:
  - `isConsoleToConsole(job): boolean` in `lib/transferStream.js` — true
    when `job.source_kind === 'ps5-ftp'`, `job.dest_kind === 'ps5-ftp'` and
    `job.source_ip !== job.ip`.
  - `streamConsoleToConsole(job, ftp, onBytes): Promise<void>` in
    `convert.js` — one `PassThrough` between the source's
    `downloadTo(stream, path)` and the destination's `uploadFrom(stream,
    name)`, with the destination's directory ensured first.

- [ ] **Step 1: Write the failing test**

```js
// backend/src/lib/transferStream.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isConsoleToConsole } from './transferStream.js';

test('two different consoles stream, anything else stages', () => {
  const base = { source_kind: 'ps5-ftp', dest_kind: 'ps5-ftp', source_ip: '192.0.2.5', ip: '192.0.2.6' };
  assert.equal(isConsoleToConsole(base), true);
  assert.equal(isConsoleToConsole({ ...base, ip: '192.0.2.5' }), false);      // same console: the FTP server moves it
  assert.equal(isConsoleToConsole({ ...base, dest_kind: 'local' }), false);  // to the server disk
  assert.equal(isConsoleToConsole({ ...base, source_kind: 'local' }), false);
  assert.equal(isConsoleToConsole({ ...base, source_kind: 'remote-smb' }), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npm test -- --test-name-pattern="stream"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `isConsoleToConsole` and wire the stream path**

In `executeFtpUploadJob`, when `isConsoleToConsole(job)`: skip the staging
branch entirely (no temp dir, no `assertFreeSpace` on the host), call
`streamConsoleToConsole` with the progress callback the staged path uses,
then verify the destination size against `job.size` **for copies as well as
moves** before the move's source delete. Log
`[manager] Streaming <name> from <source_ip> to <ip> (nothing is written on the server)`.

- [ ] **Step 4: Failure leaves nothing behind (Review Focus 4)**

On any error in the stream path, remove the partial destination file
(`client.remove(joinPath(dest_path, file_name))`, failures ignored), leave
the source alone, and fail the item with a message that says a streamed
copy has no resume and can be retried from the queue. Add the assertion to
the test file by driving `streamConsoleToConsole` with a stub client pair
whose source throws mid-stream, and assert the destination `remove` was
called and the source `remove` was not.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 6: Check it on the hardware by hand**

Copy one file PS5 → PS4 and one PS4 → PS5 in the dual-pane browser; confirm
the file arrives with the right size, the Tasks entry shows progress, and
`df` on the host shows no temporary file growing in the work directory.

- [ ] **Step 7: Commit**

```bash
git add backend/src/lib/transferStream.js backend/src/lib/transferStream.test.js \
        backend/src/routes/convert.js
git commit -m "Copy between two consoles without parking it on the server"
```

---

### Task 5: Download into the console folder you are looking at

**Files:**
- Modify: `frontend/src/components/FileBrowser.jsx` (the pane's action row)
- Modify: `frontend/src/components/FileOps.jsx` only if the browser needs a
  new prop to reach the downloader
- Modify: `backend/src/routes/downloader.js` — the zftpd error path
  (`zftpdConnect`, around 348-366)

**Interfaces:**
- Consumes: the existing `POST /api/downloader` with
  `{ url, dest_kind: 'ps5', ps5_ip, dest_path }` (see
  `Downloader.jsx:65-69`).
- Produces: nothing other components depend on.

- [ ] **Step 1: Add "Download here" to a console pane**

Visible only when the pane's location is a console (`kind === 'ftp'`).
It asks for a URL in a `Modal`, then posts the existing downloader request
with the pane's console IP and current path, and tells the user the console
is fetching it and that Tasks shows the progress.

- [ ] **Step 2: Make the old-zftpd case actionable**

`zftpdConnect`'s `noApi` message already names the 1.6.0+ "zhttp" build.
Add the payload library's name for it to the message so the user knows what
to send (`zftpd-ps5-v<version>.elf`), and return it as a 409 with
`{ error, needs_payload: 'zftpd' }` so the UI can offer the library's
existing send action instead of only printing text.

- [ ] **Step 3: Verify the build**

Run: `cd frontend && npm run build`
Expected: builds cleanly.

- [ ] **Step 4: Check it on the console by hand**

With the newer zftpd running: download a small file into
`/data/homebrew` from the browser pane and confirm the console fetched it
(the job log says `[ps5] console accepted transfer`). With the older zftpd:
confirm the 409 and its message.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/FileBrowser.jsx backend/src/routes/downloader.js
git commit -m "Let the console fetch a download into the folder you are in"
```

---

### Task 6: Say where an extract runs

**Files:**
- Modify: `backend/src/routes/convert.js` — `validateExtractParams`
  (2392-2474), `buildExtractJob`, `extractQueueItemPublic` (2758),
  `/extract/check` (2730)
- Modify: `frontend/src/components/FileBrowser.jsx` (the extract dialog) and
  `frontend/src/components/Queue.jsx` (the Tasks row)
- Test: `backend/src/lib/extractWhere.test.js` (create), with the decision
  in `backend/src/lib/extractWhere.js`

**Interfaces:**
- Produces: `extractWhere(archiveType: string, source: string): { where:
  'console' | 'host', reason: string | null }` — `console` only for a
  console source whose type the engine can do today; otherwise `host` with
  a reason in plain words.

- [ ] **Step 1: Write the failing test (Review Focus 5)**

`archiveType` is what `detectArchiveType()` returns: `zip`, `rar`, `7z`,
`tar` or `tgz`. In phase 1 the engine can unpack none of them, so every
archive is a host job — the point of the function is that it says so, and
that phase 2 adds `zip` in one place.

```js
// backend/src/lib/extractWhere.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWhere } from './extractWhere.js';

test('archives on a console are unpacked on the server in this phase, and say so', () => {
  for (const type of ['zip', 'rar', '7z', 'tar', 'tgz']) {
    const got = extractWhere(type, 'ftp');
    assert.equal(got.where, 'host', type);
    assert.match(got.reason, /console engine cannot unpack/i);
  }
});

test('anything that is not on a console is a server job without a reason to explain', () => {
  assert.deepEqual(extractWhere('zip', 'smb'), { where: 'host', reason: null });
  assert.deepEqual(extractWhere('zip', 'local-fs'), { where: 'host', reason: null });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd backend && npm test -- --test-name-pattern="unpack"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `extractWhere` and carry it through**

`validateExtractParams` returns `where` and `whereReason` from it;
`buildExtractJob` stamps them on the job; `extractQueueItemPublic` exposes
`where`; `/extract/check` returns `{ needs_password, where, where_reason }`
so the dialog can show it before anything is queued.

- [ ] **Step 4: Show it in the UI**

The extract dialog says "Unpacked on the console" or "Unpacked on the
server" with the reason when there is one; the Tasks row shows the same as a
`Badge`. No silent fallback: the console option is not offered at all for a
type the engine cannot do.

- [ ] **Step 5: Run the tests and build**

Run: `cd backend && npm test && cd ../frontend && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/extractWhere.js backend/src/lib/extractWhere.test.js \
        backend/src/routes/convert.js frontend/src/components/FileBrowser.jsx \
        frontend/src/components/Queue.jsx
git commit -m "Say whether an archive is unpacked on the console or the server"
```

---

### Task 7: Convert a title straight from the Library

**Files:**
- Modify: `frontend/src/components/Library.jsx` — the title dialog's
  `lib-actions` row (around 413-430) and a new dialog beside the Rename one

**Interfaces:**
- Consumes: `ConsoleGameActions({ ip, game, busy, onStarted, onError })`
  from Task 3, and `GET /api/gamecompressor/<ip>/engine/lzc/job` for the
  busy check. The Library's game carries `title_id` and `path`, which are
  the engine's `titleId` and `sourcePath`; map them when rendering, do not
  change the component's props.

- [ ] **Step 1: Add the action**

A `🗜 Convert to…` button in `lib-actions`, between `Unpack to…` and
`Rename`. Rendered only when the profile is not a PS4 one
(`!isPs4Profile`), disabled on the same conditions the neighbouring buttons
use (`busy || jobActive || !game.source_available`). It opens a `Modal`
titled `Convert <title>` holding `ConsoleGameActions` for that title; the
format and what happens to the original are picked there.

- [ ] **Step 2: Respect the engine's one-job rule (Review Focus 3)**

When the dialog opens, read `engine/lzc/job`. While it reports `busy`, the
form is disabled and the dialog says which title the console is working on.
When the engine does not answer at all, the dialog says the engine is not
running and offers the same Start the Convert panel uses, rather than
showing a dead form.

- [ ] **Step 3: Verify the build**

Run: `cd frontend && npm run build`
Expected: builds cleanly.

- [ ] **Step 4: Check it on the console by hand**

Open a title in Library → Convert to… → pick `.ffpfsc` (exFAT) with
`Keep original`, start it, and confirm the job shows up in the Convert
panel's progress and in the engine's history. Then confirm a second
Convert to… while that job runs is refused in words, not by spinning.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Library.jsx
git commit -m "Convert a title from the Library, format picked there"
```

---

## After this plan

Phase 2 (zip in the engine, `lzc_archive.c` + `POST /api/lzc/extract-archive`)
and phase 3 (rar via vendored libarchive, gated on a spike that proves
libarchive builds against the PS5 payload SDK) get their own plan. When
phase 2 lands, `extractWhere` gains `zip` for `ftp` sources and Task 6's
test grows one line — which is the whole point of putting the decision in
one function.
