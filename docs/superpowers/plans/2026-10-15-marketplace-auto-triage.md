# Marketplace automatic triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new version of an item its verified owner already owns reaches the catalog without a maintainer touching it; everything else still waits for review.

**Architecture:** All the work lands in `quatrixone/p5-marketplace`. Two new pure modules carry the judgement — `storeUrls.js` decides whether a URL belongs to the submitter, `storeTriage.js` turns an item plus its previous version plus the GitHub issue author into one of `auto`, `review` or `reject` — and a thin runner script (`scripts/store-triage.mjs`) plus one workflow job wire them to GitHub. The runner reuses the existing `store-accept.mjs` for the accepted path, so checksum pinning and version bumping keep their single implementation.

**Tech Stack:** Node 22, `node --test`, plain ESM, GitHub Actions. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-marketplace-submissions-design.md` (sections "Automation in p5-marketplace" and "No games")

**Repository note:** every path below is relative to `../p5-marketplace` unless it says otherwise. That repository's commits are authored as `quatrixone <57962558+quatrixone@users.noreply.github.com>` with no AI attribution trailers.

## Global Constraints

- The GitHub identity always comes from `github.event.issue.user`, never from submitted JSON — the rule `store-accept.mjs` already follows.
- `auto` requires all of: the submitter owns the previous version; every URL is the submitter's own release asset or unchanged; `id`, `kind`, `builtin_id` and `owner.github_id` unchanged; at most **5** automatic acceptances per account per **24 hours**; the item does not carry `auto: false`.
- Retail title ids (`CUSA#####`, `PPSA#####`) are refused outright. Homebrew and payload files are capped at **2 GB**, and on an automatic update a file may not grow more than **4×** against the previous version.
- The size caps are applied to every declared file size, including files whose URL did not change. That is stricter than the spec, which skips checks for unchanged URLs; a declared size is cheap to check and a shrinking catalog item is not a thing worth defending.
- A failed condition on an otherwise ownable update yields `review`, never `reject` and never publication.
- Automatic commits carry `(auto-accept #<issue>)` in the subject and a `Auto-accepted-for: <github_id>` trailer, which is how the rate limit is counted.
- No new runtime dependency, and no change to what the app fetches.

## Review Focus

- A `download` step URL or a URL inside script text pointing at someone else's host must not ride in on an automatic update — the item's visible fields are not the only place a URL lives. Pinned in Task 1.
- `https://github.com.evil.tld/me/repo/releases/download/x`, `https://user@github.com/...` and `https://GitHub.com/Me/...` must be judged on the real host and account, not on a substring. Pinned in Task 1.
- An update that keeps every URL byte-identical must stay `auto` even when the author's account was renamed, because the id is what owns an item. Pinned in Task 2.
- A submission whose previous version does not exist must never reach the automatic path by way of a missing-field default. Pinned in Task 2.
- A 2.5 GB file, and a 100 MB file replacing a 10 MB one, must both land in `review` rather than be published unseen. Pinned in Task 3.

---

### Task 1: Which URLs an item carries, and whether they are the submitter's

**Files:**
- Create: `backend/src/lib/storeUrls.js`
- Test: `backend/src/lib/storeUrls.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `collectItemUrls(item) → string[]` — every URL anywhere in the item: `files[].url`, `homepage`, `icon`, URLs in template `steps` (including nested `url`, `dest_path` is not a URL), and URLs inside `script` text.
  - `isAuthorReleaseUrl(url, login) → boolean` — true only for `https://github.com/<login>/<repo>/releases/download/...`, case-insensitively on the host and the account, with no userinfo.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/src/lib/storeUrls.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItemUrls, isAuthorReleaseUrl } from './storeUrls.js';

test('every URL an item carries is collected, including nested and in-script ones', () => {
  const item = {
    kind: 'template',
    homepage: 'https://github.com/me/repo',
    steps: [
      { type: 'download', url: 'https://github.com/me/repo/releases/download/v1/a.zip', dest_path: '/data/x' },
      { type: 'input_script', script: 'text https://example.org/in-script\nwait 200' },
    ],
  };
  assert.deepEqual(collectItemUrls(item).sort(), [
    'https://example.org/in-script',
    'https://github.com/me/repo',
    'https://github.com/me/repo/releases/download/v1/a.zip',
  ]);
  assert.deepEqual(collectItemUrls({ kind: 'homebrew', files: [{ url: 'https://github.com/me/r/releases/download/v1/a.pkg' }], icon: 'https://example.org/i.png' }).sort(), [
    'https://example.org/i.png',
    'https://github.com/me/r/releases/download/v1/a.pkg',
  ]);
  assert.deepEqual(collectItemUrls({ kind: 'script', script: 'home\nwait 1200' }), []);
});

test('only the submitter own release assets count as authored', () => {
  assert.equal(isAuthorReleaseUrl('https://github.com/me/repo/releases/download/v1/a.pkg', 'me'), true);
  assert.equal(isAuthorReleaseUrl('https://GitHub.com/Me/repo/releases/download/v1/a.pkg', 'me'), true);
  assert.equal(isAuthorReleaseUrl('https://github.com/someone/repo/releases/download/v1/a.pkg', 'me'), false);
  assert.equal(isAuthorReleaseUrl('https://github.com.evil.tld/me/repo/releases/download/v1/a.pkg', 'me'), false);
  assert.equal(isAuthorReleaseUrl('https://user@github.com/me/repo/releases/download/v1/a.pkg', 'me'), false);
  assert.equal(isAuthorReleaseUrl('http://github.com/me/repo/releases/download/v1/a.pkg', 'me'), false);
  assert.equal(isAuthorReleaseUrl('https://github.com/me/repo/archive/refs/heads/main.zip', 'me'), false);
  assert.equal(isAuthorReleaseUrl('not a url', 'me'), false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeUrls.test.js`
Expected: FAIL — `Cannot find module './storeUrls.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/src/lib/storeUrls.js
// Where a submitted item can hide a URL, and whether a URL is one the
// submitter hosts themselves. Both answers gate automatic acceptance, so
// they are deliberately strict: anything unrecognised is not authored.

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/g;

function walk(value, found) {
  if (typeof value === 'string') {
    for (const hit of value.match(URL_IN_TEXT) || []) found.add(hit);
    return;
  }
  if (Array.isArray(value)) { for (const entry of value) walk(entry, found); return; }
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) walk(entry, found); }
}

// Every URL anywhere in the item, including template steps and script text.
export function collectItemUrls(item) {
  const found = new Set();
  walk(item, found);
  return [...found];
}

export function isAuthorReleaseUrl(url, login) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  const parts = parsed.pathname.split('/').filter(Boolean);
  // <login>/<repo>/releases/download/<tag>/<asset>
  if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') return false;
  return typeof login === 'string' && parts[0].toLowerCase() === login.toLowerCase();
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeUrls.test.js`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
cd ../p5-marketplace
git add backend/src/lib/storeUrls.js backend/src/lib/storeUrls.test.js
git commit -m "feat(store): find an item's URLs and tell the submitter's own apart"
```

---

### Task 2: The triage decision

**Files:**
- Create: `backend/src/lib/storeTriage.js`
- Test: `backend/src/lib/storeTriage.test.js`

**Interfaces:**
- Consumes: `collectItemUrls`, `isAuthorReleaseUrl` from Task 1; `assignSubmissionOwner` semantics from `backend/src/lib/storeOwnership.js` (ownership lives on `previous.owner.github_id`).
- Produces: `decideSubmission(item, previous, user, state) → { action: 'auto' | 'review' | 'reject', reason: string }`, where `user` is `{ id, login }` from the issue event and `state` is `{ autoAcceptedLast24h: number }`.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/src/lib/storeTriage.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSubmission } from './storeTriage.js';

const user = { id: 7, login: 'me' };
const asset = 'https://github.com/me/repo/releases/download/v2/app.pkg';
const previousAsset = 'https://github.com/me/repo/releases/download/v1/app.pkg';
const previous = () => ({ kind: 'homebrew', id: 'my-app', name: 'My app', description: 'd', author: 'me', version: 3,
  console_type: 'ps5', homebrew_id: 'APOL00004', files: [{ type: 'pkg', url: previousAsset, sha256: 'a'.repeat(64), size: 10 * 1024 ** 2 }],
  owner: { github_id: 7, github_login: 'me' } });
const update = (over = {}) => ({ ...previous(), files: [{ type: 'pkg', url: asset, size: 12 * 1024 ** 2 }], ...over });
const state = { autoAcceptedLast24h: 0 };

test('a new item waits for review and never reaches the automatic path', () => {
  assert.deepEqual(decideSubmission(update(), null, user, state).action, 'review');
  // An absent previous version must not be filled in by a default.
  assert.equal(decideSubmission(update(), undefined, user, state).action, 'review');
});

test("an owner's update with their own asset is accepted automatically", () => {
  const decision = decideSubmission(update(), previous(), user, state);
  assert.equal(decision.action, 'auto', decision.reason);
});

test('a renamed account still owns its item when nothing else changed', () => {
  const renamed = { id: 7, login: 'me-renamed' };
  const same = { ...previous(), name: 'My app, renamed' };
  assert.equal(decideSubmission(same, previous(), renamed, state).action, 'auto');
});

test('someone else cannot update an item, whatever the JSON claims', () => {
  const intruder = { id: 99, login: 'intruder' };
  assert.equal(decideSubmission(update({ owner: { github_id: 99, github_login: 'intruder' } }), previous(), intruder, state).action, 'reject');
});

test('identity fields are immutable on an update', () => {
  for (const over of [{ id: 'other-app' }, { kind: 'payload' }, { builtin_id: 'builtin:mine' }]) {
    assert.equal(decideSubmission(update(over), previous(), user, state).action, 'reject', JSON.stringify(over));
  }
});

test('a URL that is neither the submitter\'s nor unchanged falls back to review', () => {
  assert.equal(decideSubmission(update({ files: [{ type: 'pkg', url: 'https://github.com/someone/repo/releases/download/v1/app.pkg' }] }), previous(), user, state).action, 'review');
  // Unchanged URLs from the previous version are allowed even off-account.
  const carried = { ...previous(), files: [{ type: 'pkg', url: previousAsset, sha256: 'a'.repeat(64), size: 10 * 1024 ** 2 }], name: 'Renamed' };
  assert.equal(decideSubmission(carried, { ...previous(), files: [{ type: 'pkg', url: previousAsset }] }, user, state).action, 'auto');
});

test('the daily automatic allowance and a frozen item both defer to review', () => {
  assert.equal(decideSubmission(update(), previous(), user, { autoAcceptedLast24h: 5 }).action, 'review');
  assert.equal(decideSubmission(update({ auto: false }), previous(), user, state).action, 'review');
  assert.equal(decideSubmission(update(), { ...previous(), auto: false }, user, state).action, 'review');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeTriage.test.js`
Expected: FAIL — `Cannot find module './storeTriage.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// backend/src/lib/storeTriage.js
// Whether a submission publishes itself. The only automatic case is a new
// version of an item the submitter already owns, with nothing identifying
// changed and no URL that is not theirs. Everything a check cannot clear
// goes to a maintainer; nothing unclear is published.
import { collectItemUrls, isAuthorReleaseUrl } from './storeUrls.js';

export const AUTO_PER_DAY = 5;

const review = (reason) => ({ action: 'review', reason });
const reject = (reason) => ({ action: 'reject', reason });

export function decideSubmission(item, previous, user, state = {}) {
  if (!item || typeof item !== 'object') return reject('the submission is not an item');
  if (!Number.isSafeInteger(user?.id) || user.id < 1 || typeof user?.login !== 'string') return reject('a verified GitHub issue author is required');
  if (!previous) return review('a new item is reviewed by a maintainer');

  const ownerId = previous.owner?.github_id;
  if (!Number.isSafeInteger(ownerId)) return review('the previous version has no user owner');
  if (ownerId !== user.id) return reject('only the owner can update this item');

  for (const field of ['id', 'kind', 'builtin_id']) {
    if ((item[field] ?? null) !== (previous[field] ?? null)) return reject(`${field} cannot change in an update`);
  }
  if (item.owner && item.owner.github_id !== ownerId) return reject('owner cannot change in an update');

  if (item.auto === false || previous.auto === false) return review('automatic acceptance is turned off for this item');
  if ((state.autoAcceptedLast24h ?? 0) >= AUTO_PER_DAY) return review(`more than ${AUTO_PER_DAY} automatic acceptances in 24 hours`);

  const carried = new Set(collectItemUrls(previous));
  for (const url of collectItemUrls(item)) {
    if (carried.has(url)) continue;
    if (!isAuthorReleaseUrl(url, user.login)) return review(`${url} is not a release asset of this account`);
  }
  return { action: 'auto', reason: 'an update to an item this account owns' };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeTriage.test.js backend/src/lib/storeUrls.test.js`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
cd ../p5-marketplace
git add backend/src/lib/storeTriage.js backend/src/lib/storeTriage.test.js
git commit -m "feat(store): decide a submission without a maintainer where it is safe"
```

---

### Task 3: No games, by machine

**Files:**
- Modify: `backend/src/lib/storeTriage.js` (the checks, in `decideSubmission`)
- Test: `backend/src/lib/storeTriage.test.js` (extend)

**Interfaces:**
- Consumes: `decideSubmission` from Task 2.
- Produces: `RETAIL_TITLE_ID` (`/^(CUSA|PPSA)\d{5}$/i`), `MAX_FILE_BYTES` (2 GB) and `MAX_GROWTH` (4) exported from `storeTriage.js`; `decideSubmission` rejects a retail title id and sends an oversized or fast-growing file to `review`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/lib/storeTriage.test.js`:

```javascript
test('a retail title id is refused outright', () => {
  for (const id of ['CUSA12345', 'PPSA01234', 'ppsa01234']) {
    const decision = decideSubmission(update({ homebrew_id: id }), previous(), user, state);
    assert.equal(decision.action, 'reject', id);
    assert.match(decision.reason, /retail/);
  }
  assert.equal(decideSubmission(update({ homebrew_id: 'APOL00004' }), previous(), user, state).action, 'auto');
});

test('an oversized or suddenly much larger file waits for a maintainer', () => {
  const big = decideSubmission(update({ files: [{ type: 'pkg', url: asset, size: 2.5 * 1024 ** 3 }] }), previous(), user, state);
  assert.equal(big.action, 'review');
  assert.match(big.reason, /2 GB|larger/);
  // 10 MB previously, 100 MB now: ten times, past the fourfold allowance.
  const grown = decideSubmission(update({ files: [{ type: 'pkg', url: asset, size: 100 * 1024 ** 2 }] }), previous(), user, state);
  assert.equal(grown.action, 'review');
  assert.match(grown.reason, /larger/);
  // Within the allowance, and a submission without a declared size is not
  // guessed at - the accept step measures it.
  assert.equal(decideSubmission(update({ files: [{ type: 'pkg', url: asset, size: 30 * 1024 ** 2 }] }), previous(), user, state).action, 'auto');
  assert.equal(decideSubmission(update({ files: [{ type: 'pkg', url: asset }] }), previous(), user, state).action, 'auto');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeTriage.test.js`
Expected: FAIL — a retail title id is accepted automatically and the 2.5 GB file is `auto`.

- [ ] **Step 3: Write minimal implementation**

In `backend/src/lib/storeTriage.js`, beside `AUTO_PER_DAY`:

```javascript
// A repackaged retail game is the one thing automatic acceptance must not
// let through, and a retail title id is the cheapest reliable sign of one.
export const RETAIL_TITLE_ID = /^(CUSA|PPSA)\d{5}$/i;
export const MAX_FILE_BYTES = 2 * 1024 ** 3;
export const MAX_GROWTH = 4;
```

and in `decideSubmission`, after the immutable-field checks and before the `auto` return:

```javascript
  if (typeof item.homebrew_id === 'string' && RETAIL_TITLE_ID.test(item.homebrew_id)) return reject(`${item.homebrew_id} is a retail title id; this catalog lists homebrew only`);

  const previousSize = Math.max(0, ...(previous.files || []).map(f => Number(f.size) || 0));
  for (const file of item.files || []) {
    const size = Number(file.size) || 0;
    if (size > MAX_FILE_BYTES) return review(`${file.url} is larger than 2 GB`);
    if (previousSize && size > previousSize * MAX_GROWTH) return review(`${file.url} is more than ${MAX_GROWTH}× larger than the published version`);
  }
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd ../p5-marketplace && node --test backend/src/lib/*.test.js`
Expected: PASS, every file.

- [ ] **Step 5: Commit**

```bash
cd ../p5-marketplace
git add backend/src/lib/storeTriage.js backend/src/lib/storeTriage.test.js
git commit -m "feat(store): no automatic path for retail packages"
```

---

### Task 4: The runner and the workflow job

**Files:**
- Create: `scripts/store-triage.mjs`
- Modify: `.github/workflows/store.yml` (a `triage` job on `issues: [opened]`, and the new tests in `check`)
- Modify: `store/README.md` (what happens to a submission now)
- Test: `scripts/store-triage.test.mjs` (create)

**Interfaces:**
- Consumes: `decideSubmission` from Tasks 2-3, `store-accept.mjs` for the accepted path.
- Produces: `node scripts/store-triage.mjs <issue body file>` printing `auto <path>`, `review <reason>` or `reject <reason>`, with the identity read from `STORE_AUTHOR_ID` / `STORE_AUTHOR_LOGIN` and the rate limit counted from `git log`.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/store-triage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/store-triage.mjs');

function triage(item, env = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'triage-')), 'issue.md');
  fs.writeFileSync(file, `### Item\n\n\`\`\`json\n${JSON.stringify(item, null, 2)}\n\`\`\`\n`);
  return execFileSync(process.execPath, [script, file], { cwd: root, encoding: 'utf8',
    env: { ...process.env, STORE_AUTHOR_ID: '57962558', STORE_AUTHOR_LOGIN: 'quatrixone', STORE_TRIAGE_DRY_RUN: '1', ...env } }).trim();
}

test('a new item is reported as needing review, and nothing is written', () => {
  const before = fs.readdirSync(path.join(root, 'store/scripts')).length;
  const out = triage({ kind: 'script', id: 'brand-new-thing', name: 'New', description: 'd', author: 'quatrixone', version: 1, console_type: 'ps5', script: 'home\nwait 1200' });
  assert.match(out, /^review /);
  assert.equal(fs.readdirSync(path.join(root, 'store/scripts')).length, before);
});

test('an update from the owner is reported as automatic', () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'store/scripts/home-ps5.json'), 'utf8'));
  const out = triage({ ...current, script: 'home\nwait 1300' });
  assert.match(out, /^auto /);
});

test('an update from another account is reported as rejected', () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'store/scripts/home-ps5.json'), 'utf8'));
  const out = triage({ ...current, script: 'home\nwait 1300' }, { STORE_AUTHOR_ID: '999', STORE_AUTHOR_LOGIN: 'someone' });
  assert.match(out, /^reject /);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test scripts/store-triage.test.mjs`
Expected: FAIL — the script does not exist.

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/store-triage.mjs
// Decides a submission issue without a maintainer where that is safe, and
// says so in one line: `auto <path>`, `review <reason>`, `reject <reason>`.
// The identity comes from the GitHub issue event, never from the JSON.
//
//   STORE_AUTHOR_ID=<id> STORE_AUTHOR_LOGIN=<login> node scripts/store-triage.mjs <issue body file>
//   STORE_TRIAGE_DRY_RUN=1 decides without writing anything.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { decodeCatalog } from '../backend/src/lib/catalogLinks.js';
import { validateStoreItem, storeDir } from '../backend/src/lib/storeItem.js';
import { decideSubmission } from '../backend/src/lib/storeTriage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bodyFile = process.argv[2];
if (!bodyFile) { console.error('usage: store-triage.mjs <issue body file>'); process.exit(2); }

const block = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(fs.readFileSync(bodyFile, 'utf8'));
if (!block) { console.log('review the issue has no JSON block'); process.exit(0); }

let item;
try { item = decodeCatalog(JSON.parse(block[1])); }
catch (e) { console.log(`review the JSON does not parse (${e.message})`); process.exit(0); }

const errors = validateStoreItem(item, { submission: true });
if (errors.length) { console.log(`review ${errors.join('; ')}`); process.exit(0); }

const rel = `store/${storeDir(item.kind)}/${item.id}.json`;
const file = path.join(root, rel);
const previous = fs.existsSync(file) ? decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
const user = { id: Number(process.env.STORE_AUTHOR_ID), login: process.env.STORE_AUTHOR_LOGIN };

// Each automatic commit carries the account it was accepted for, so the
// allowance is counted from history rather than kept anywhere.
const counted = execFileSync('git', ['log', '--since=24 hours ago', '--format=%B'], { cwd: root, encoding: 'utf8' });
const autoAcceptedLast24h = (counted.match(new RegExp(`^Auto-accepted-for: ${user.id}$`, 'gm')) || []).length;

const decision = decideSubmission(item, previous, user, { autoAcceptedLast24h });
if (decision.action !== 'auto') { console.log(`${decision.action} ${decision.reason}`); process.exit(0); }
if (process.env.STORE_TRIAGE_DRY_RUN === '1') { console.log(`auto ${rel}`); process.exit(0); }

// The accepted path stays in store-accept.mjs: one implementation of
// checksum pinning, version bumping and index rebuilding.
execFileSync(process.execPath, [path.join(root, 'scripts/store-accept.mjs'), bodyFile], { cwd: root, stdio: 'inherit' });
console.log(`auto ${rel}`);
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd ../p5-marketplace && node --test scripts/store-triage.test.mjs backend/src/lib/*.test.js && git status --short`
Expected: PASS for every test, and `git status --short` shows no modified `store/` file — the dry run wrote nothing.

- [ ] **Step 5: Wire the workflow, document it, and commit**

In `.github/workflows/store.yml`, add `opened` to the issues trigger:

```yaml
  issues:
    types: [labeled, opened]
```

add the new tests to the `check` job:

```yaml
      - run: node --test backend/src/lib/storeUrls.test.js backend/src/lib/storeTriage.test.js scripts/store-triage.test.mjs
```

and add the job:

```yaml
  triage:
    permissions:
      contents: write
      issues: write
    if: github.event_name == 'issues' && github.event.action == 'opened'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Decide the submission
        id: triage
        env:
          BODY: ${{ github.event.issue.body }}
          STORE_AUTHOR_ID: ${{ github.event.issue.user.id }}
          STORE_AUTHOR_LOGIN: ${{ github.event.issue.user.login }}
        run: |
          set -euo pipefail
          printf '%s' "$BODY" > "$RUNNER_TEMP/issue.md"
          node scripts/store-triage.mjs "$RUNNER_TEMP/issue.md" | tail -1 > "$RUNNER_TEMP/decision"
          echo "decision=$(cat "$RUNNER_TEMP/decision")" >> "$GITHUB_OUTPUT"
      - name: Act on the decision
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ISSUE: ${{ github.event.issue.number }}
          TITLE: ${{ github.event.issue.title }}
          AUTHOR_ID: ${{ github.event.issue.user.id }}
          DECISION: ${{ steps.triage.outputs.decision }}
        run: |
          set -euo pipefail
          action="${DECISION%% *}"; detail="${DECISION#* }"
          case "$action" in
            auto)
              git config user.name "github-actions[bot]"
              git config user.email "41898283+github-actions[bot]@users.noreply.github.com"
              git add store
              git commit -m "store: ${TITLE#\[store\] } (auto-accept #$ISSUE)" -m "Auto-accepted-for: $AUTHOR_ID"
              git push origin HEAD:main
              gh issue comment "$ISSUE" --body "Published automatically as an update to an item this account owns: \`$detail\`. It reaches the app within ten minutes."
              gh issue close "$ISSUE"
              ;;
            review)
              gh issue edit "$ISSUE" --add-label store-review
              gh issue comment "$ISSUE" --body "Queued for a maintainer: $detail"
              ;;
            reject)
              gh issue comment "$ISSUE" --body "This submission cannot be accepted: $detail"
              gh issue close "$ISSUE"
              ;;
          esac
```

In `store/README.md`, under the submission description, add:

```markdown
A submission that updates an item the same GitHub account already owns is
published automatically: the checks are the account's ownership, that `id`,
`kind` and `builtin_id` are unchanged, that every URL is a release asset of
that account or unchanged from the published version, that no file is over
2 GB or more than four times larger than before, that the title id is not a
retail one, and at most five automatic acceptances per account per day. An
item carrying `auto: false` is never published automatically. Everything
else — every new item, and any update a check cannot clear — waits for a
maintainer's `store-accepted` label.
```

```bash
cd ../p5-marketplace
git add scripts/store-triage.mjs scripts/store-triage.test.mjs .github/workflows/store.yml store/README.md
git commit -m "feat(store): triage a submission issue when it opens"
git push origin main
```

---

## Follow-ups, deliberately not in this plan

- The device-flow login and in-app upload to the author's own release are the next plan; this one makes the catalog side ready for them.
- A `store-review` label does not exist in the repository until the first `review` decision creates it; `gh issue edit --add-label` creates it on the fly, but giving it a colour and description by hand is a one-minute maintainer task left to the user.
