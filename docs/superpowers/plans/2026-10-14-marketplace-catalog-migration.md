# Marketplace catalog migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `quatrixone/p5-marketplace` the single catalog the app reads, and stop the app offering retail FPKGi categories.

**Architecture:** The two repositories' shared libraries have diverged: `p5-marketplace` carries the newer ownership model (`owner: { github_id, github_login }`) but knows nothing about `builtin_id`, `notes`, or the generated `store/builtin/*` runtime manifests the app needs for curated scripts and templates. This plan makes `p5-marketplace` the superset, brings its curated items up to date, then points the app at it and reads the new ownership shape with a legacy fallback. The FPKGi category removal is independent and ships in the same plan because it is the app-side half of the no-games policy.

**Tech Stack:** Node 22, `node --test`, plain ESM, GitHub Actions. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-marketplace-submissions-design.md`

## Global Constraints

- Catalog repository: `quatrixone/p5-marketplace`, branch `main`.
- Item ownership in the catalog is `owner: { github_id, github_login }`; the app must keep reading the legacy `github_owner_id` so older items and the app's own `store/` keep working.
- FPKGi categories that stay: `homebrew`, `apps`, `emulators`. Removed: `games`, `updates`, `dlc`, `demos`, `themes`, `ps1`, `ps2`, `psp`.
- `builtin_id` stays `builtin:<id>` for scripts and `tpl-<id>` for templates.
- No item file may contain plain links; `hasPlainLinks` already enforces this in CI.
- Commits in both repositories are authored as `quatrixone <57962558+quatrixone@users.noreply.github.com>` with no AI attribution trailers.
- The app's in-image `frontend/builtin/payloads.json` stays as the offline fallback; nothing in this plan removes it.

## Review Focus

- A catalog item carrying only `owner.github_id` must be recognised as owned by that account — otherwise every migrated item looks unowned and "Update my item" lists nothing. Pinned in Task 4.
- An existing `news.json` already holds snapshots from removed categories; after the update those retail entries must disappear from **New**, not linger forever because their source stopped being collected. Pinned in Task 5.
- `catalogPath('ps4', 'games')` from a stale bookmark or a cached frontend must fail with the 400 "Unknown platform or catalog category", never fetch a retail file. Pinned in Task 5.
- A missing `store/builtin/inputScripts.json` on the catalog must keep the last persisted copy and report a warning, never present an empty curated list. Pinned in Task 4.
- Two items claiming the same `builtin_id` must fail the index build rather than produce a manifest where one silently wins. Pinned in Task 2.

---

### Task 1: `builtin_id` and `notes` in the catalog repository's schema

**Files:**
- Modify: `../p5-marketplace/backend/src/lib/storeItem.js:46-117` (validation) and `:118-137` (`indexEntry`)
- Test: `../p5-marketplace/backend/src/lib/storeItem.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `validateStoreItem(item, { submission })` accepting `builtin_id` and `notes`; `indexEntry(item, path)` emitting `builtin_id` when present.

- [ ] **Step 1: Write the failing test**

```javascript
// ../p5-marketplace/backend/src/lib/storeItem.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStoreItem, indexEntry } from './storeItem.js';

const script = () => ({ kind: 'script', id: 'open-user-guide', name: 'Open', description: 'd', author: 'quatrixone', version: 1, console_type: 'ps5', script: 'home\nwait 1200' });

test('curated scripts and templates may carry a builtin_id', () => {
  assert.deepEqual(validateStoreItem({ ...script(), builtin_id: 'builtin:open-user-guide' }), []);
  assert.deepEqual(validateStoreItem({ ...script(), kind: 'homebrew', builtin_id: 'builtin:x' }).filter(e => e.includes('builtin_id')), ['builtin_id is only valid for curated scripts and templates']);
  assert.deepEqual(validateStoreItem({ ...script(), builtin_id: 'tpl-open-user-guide' }).filter(e => e.includes('builtin_id')), ['builtin_id is only valid for curated scripts and templates']);
});

test('notes are optional text and reach the item, not the index', () => {
  assert.deepEqual(validateStoreItem({ ...script(), notes: 'PS5 only.' }), []);
  assert.ok(validateStoreItem({ ...script(), notes: 'x'.repeat(2001) }).some(e => e.includes('notes')));
  assert.equal(indexEntry({ ...script(), builtin_id: 'builtin:open-user-guide' }, 'scripts/open-user-guide.json').builtin_id, 'builtin:open-user-guide');
  assert.equal(indexEntry(script(), 'scripts/open-user-guide.json').notes, undefined);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeItem.test.js`
Expected: FAIL — `builtin_id` produces no error for homebrew, and `indexEntry(...).builtin_id` is `undefined`.

- [ ] **Step 3: Implement the minimal code**

In `validateStoreItem`, after the `owner` check:

```javascript
  if (item.builtin_id !== undefined && (typeof item.builtin_id !== 'string' || !((item.kind === 'script' && /^builtin:[a-z0-9-]+$/.test(item.builtin_id)) || (item.kind === 'template' && /^tpl-[a-z0-9-]+$/.test(item.builtin_id))))) errors.push('builtin_id is only valid for curated scripts and templates');
  if (item.notes !== undefined) text(item.notes, 2000, 'notes', errors);
```

In `indexEntry`, beside the other conditional fields:

```javascript
    ...(item.builtin_id ? { builtin_id: item.builtin_id } : {}),
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd ../p5-marketplace && node --test backend/src/lib/storeItem.test.js backend/src/lib/storeOwnership.test.js`
Expected: PASS, both files.

- [ ] **Step 5: Commit**

```bash
cd ../p5-marketplace
git add backend/src/lib/storeItem.js backend/src/lib/storeItem.test.js
git commit -m "feat(store): curated items may carry builtin_id and notes"
```

---

### Task 2: Generate the runtime manifests in the catalog repository

**Files:**
- Modify: `../p5-marketplace/scripts/build-store-index.mjs` (append the manifest stage after the index is written)
- Create: `../p5-marketplace/store/builtin/payloads.json` (seeded from the app's `frontend/builtin/payloads.json`)
- Modify: `../p5-marketplace/.github/workflows/store.yml` (the `check` job already runs `--check`; add the new test file)
- Test: `../p5-marketplace/scripts/build-store-index.test.mjs` (create)

**Interfaces:**
- Consumes: `validateStoreItem` / `indexEntry` from Task 1.
- Produces: `store/builtin/inputScripts.json`, `store/builtin/templates.json` generated from items with a `builtin_id`; `store/builtin/payloads.json` committed as a source file. `node scripts/build-store-index.mjs --check` fails when any of the three is out of date.

- [ ] **Step 1: Write the failing test**

```javascript
// ../p5-marketplace/scripts/build-store-index.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCatalog } from '../backend/src/lib/catalogLinks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (...args) => execFileSync(process.execPath, [path.join(root, 'scripts/build-store-index.mjs'), ...args], { cwd: root, encoding: 'utf8' });

test('the build writes runtime manifests from the items that carry a builtin_id', () => {
  run();
  const scripts = decodeCatalog(JSON.parse(fs.readFileSync(path.join(root, 'store/builtin/inputScripts.json'), 'utf8')));
  const guide = scripts.find(s => s.id === 'builtin:open-user-guide');
  assert.ok(guide, 'the curated guide script is in the manifest');
  assert.equal(guide.store.id, 'open-user-guide');
  assert.ok(Array.isArray(decodeCatalog(JSON.parse(fs.readFileSync(path.join(root, 'store/builtin/templates.json'), 'utf8')))));
  assert.doesNotThrow(() => run('--check'));
});

test('--check fails when a manifest is stale and a duplicate builtin_id fails the build', () => {
  const target = path.join(root, 'store/builtin/inputScripts.json');
  const good = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, '[]\n');
  assert.throws(() => run('--check'), /out of date/);
  fs.writeFileSync(target, good);

  const dir = path.join(root, 'store/scripts');
  const copy = path.join(dir, 'zz-duplicate-builtin.json');
  const source = JSON.parse(fs.readFileSync(path.join(dir, 'open-user-guide.json'), 'utf8'));
  fs.writeFileSync(copy, JSON.stringify({ ...source, id: 'zz-duplicate-builtin' }, null, 2) + '\n');
  try {
    assert.throws(() => run(), /duplicate builtin_id/);
  } finally {
    fs.unlinkSync(copy);
    run();
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test scripts/build-store-index.test.mjs`
Expected: FAIL — `store/builtin/inputScripts.json` does not exist.

- [ ] **Step 3: Implement the minimal code**

In `scripts/build-store-index.mjs`: declare the collectors beside `items`,

```javascript
const catalogs = { script: [], template: [] };
const builtinIds = new Set();
```

record a curated item where the valid item is pushed into `items`,

```javascript
      if (item.builtin_id) {
        if (builtinIds.has(item.builtin_id)) problems.push(`${rel}: duplicate builtin_id`);
        builtinIds.add(item.builtin_id);
        const { kind, id, author, version, builtin_id, owner, ...data } = item;
        catalogs[kind].push({ ...data, id: builtin_id, store: { id, author, version } });
      }
```

and after the index is written or checked:

```javascript
// Runtime catalogs are generated from the same item sources as Marketplace,
// so an install picks up a curated change without waiting for an app release.
for (const [kind, name] of [['script', 'inputScripts.json'], ['template', 'templates.json']]) {
  const target = path.join(store, 'builtin', name);
  if (check) {
    const have = fs.existsSync(target) ? decodeCatalog(JSON.parse(fs.readFileSync(target, 'utf8'))) : null;
    if (JSON.stringify(have) !== JSON.stringify(catalogs[kind])) {
      console.error(`${target} is out of date: run node scripts/build-store-index.mjs`);
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(encodeCatalog(catalogs[kind]), null, 2) + '\n');
  }
}
// The app's default payload list is a committed source file here, not
// generated: it is app-shipped data the catalog republishes so a running
// install picks up a new default without an app release.
{
  const target = path.join(store, 'builtin', 'payloads.json');
  if (!fs.existsSync(target)) {
    console.error(`${target} is missing: copy it from the app's frontend/builtin/payloads.json`);
    process.exit(1);
  }
  const payloads = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (hasPlainLinks(payloads)) {
    console.error(`${target}: unencrypted catalog links`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Seed the payload manifest and run the tests**

```bash
mkdir -p ../p5-marketplace/store/builtin
cp frontend/builtin/payloads.json ../p5-marketplace/store/builtin/payloads.json
cd ../p5-marketplace && node --test scripts/build-store-index.test.mjs && node scripts/build-store-index.mjs --check
```

Expected: PASS, and `--check` prints the item count with no staleness error.

- [ ] **Step 5: Add the tests to CI and commit**

In `.github/workflows/store.yml`, in the `check` job after the existing `storeOwnership.test.js` line:

```yaml
      - run: node --test backend/src/lib/storeItem.test.js scripts/build-store-index.test.mjs
```

```bash
cd ../p5-marketplace
git add scripts store/builtin .github/workflows/store.yml
git commit -m "feat(store): generate the runtime manifests the app reads"
```

---

### Task 3: Bring the curated items up to date

**Files:**
- Modify: `../p5-marketplace/store/scripts/{home-ps4,home-ps5,open-user-guide,user-guide-loader}.json` (add `builtin_id`, `notes`, and the current script text)
- Create: `../p5-marketplace/store/scripts/{close-game,restart-ps5}.json`
- Modify: `../p5-marketplace/store/templates/{goldhen-load,userguide-jailbreak-autoload}.json` (add `builtin_id`)
- Regenerate: `../p5-marketplace/store/index.json`, `../p5-marketplace/store/builtin/{inputScripts,templates}.json`
- Test: `../p5-marketplace/scripts/build-store-index.test.mjs` (extend)

**Interfaces:**
- Consumes: the schema from Task 1 and the manifest stage from Task 2.
- Produces: six curated scripts with `builtin_id` values `builtin:{close-game,home-ps4,home-ps5,open-user-guide,restart-ps5,user-guide-loader}` and two templates with `tpl-goldhen-load` and `tpl-userguide-jailbreak-autoload`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/build-store-index.test.mjs`:

```javascript
test('every curated script and template the app expects is present and current', () => {
  run();
  const scripts = decodeCatalog(JSON.parse(fs.readFileSync(path.join(root, 'store/builtin/inputScripts.json'), 'utf8')));
  assert.deepEqual(scripts.map(s => s.id).sort(), [
    'builtin:close-game', 'builtin:home-ps4', 'builtin:home-ps5',
    'builtin:open-user-guide', 'builtin:restart-ps5', 'builtin:user-guide-loader',
  ]);
  const templates = decodeCatalog(JSON.parse(fs.readFileSync(path.join(root, 'store/builtin/templates.json'), 'utf8')));
  assert.deepEqual(templates.map(t => t.id).sort(), ['tpl-goldhen-load', 'tpl-userguide-jailbreak-autoload']);
  // The jailbreak guide page asks for one more Cross than the certificate
  // prompt alone; three in a row is the live-tested sequence.
  const guide = scripts.find(s => s.id === 'builtin:open-user-guide');
  assert.equal(guide.script.match(/\ncross\nwait 5000/g).length, 3);
  assert.ok(guide.notes.includes('three Cross presses'));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd ../p5-marketplace && node --test scripts/build-store-index.test.mjs`
Expected: FAIL — only four scripts, none with a `builtin_id`, and the guide script has two trailing Cross presses.

- [ ] **Step 3: Port the items**

For each of the six scripts and two templates, copy the current item from this repository's `store/` and keep the catalog repository's ownership shape. Run from the app repository root:

```bash
node - <<'EOF'
import fs from 'node:fs';
const src = 'store', dst = '../p5-marketplace/store';
const owner = { github_id: 57962558, github_login: 'quatrixone' };
const builtin = {
  scripts: { 'close-game': 'builtin:close-game', 'home-ps4': 'builtin:home-ps4', 'home-ps5': 'builtin:home-ps5',
    'open-user-guide': 'builtin:open-user-guide', 'restart-ps5': 'builtin:restart-ps5', 'user-guide-loader': 'builtin:user-guide-loader' },
  templates: { 'goldhen-load': 'tpl-goldhen-load', 'userguide-jailbreak-autoload': 'tpl-userguide-jailbreak-autoload' },
};
for (const [dir, ids] of Object.entries(builtin)) {
  for (const [id, builtin_id] of Object.entries(ids)) {
    const from = `${src}/${dir}/${id}.json`;
    if (!fs.existsSync(from)) { console.error(`missing ${from}`); process.exit(1); }
    const item = JSON.parse(fs.readFileSync(from, 'utf8'));
    delete item.github_owner_id; delete item.store;
    const out = { ...item, builtin_id, owner, author: 'quatrixone' };
    fs.writeFileSync(`${dst}/${dir}/${id}.json`, JSON.stringify(out, null, 2) + '\n');
    console.log(`${dir}/${id}.json`);
  }
}
EOF
```

- [ ] **Step 4: Regenerate and run the tests**

Run: `cd ../p5-marketplace && node scripts/build-store-index.mjs && node --test scripts/build-store-index.test.mjs backend/src/lib/storeItem.test.js backend/src/lib/storeOwnership.test.js`
Expected: PASS, and `store/builtin/inputScripts.json` holds six scripts.

- [ ] **Step 5: Commit and push**

```bash
cd ../p5-marketplace
git add store scripts
git commit -m "feat(store): the curated scripts and templates the app reads"
git push origin main
```

---

### Task 4: Point the app at the catalog repository

**Files:**
- Modify: `backend/src/lib/storeItem.js:22` (`STORE_REPO`)
- Modify: `backend/src/lib/storeOwnership.js:11-15` (`ownsStoreItem`)
- Test: `backend/src/lib/storeOwnership.test.js` (extend), `backend/src/lib/marketplaceCatalog.test.js` (extend)

**Interfaces:**
- Consumes: the published catalog from Task 3.
- Produces: `STORE_REPO === 'quatrixone/p5-marketplace'`; `ownsStoreItem(item, user)` true for `item.owner.github_id === user.id` as well as the legacy `github_owner_id`.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/lib/storeOwnership.test.js`:

```javascript
test('ownership reads the catalog owner object and still accepts legacy items', () => {
  const user = { id: 57962558, login: 'quatrixone' };
  assert.equal(ownsStoreItem({ owner: { github_id: 57962558, github_login: 'quatrixone' } }, user), true);
  assert.equal(ownsStoreItem({ owner: { github_id: 1, github_login: 'someone' } }, user), false);
  assert.equal(ownsStoreItem({ github_owner_id: 57962558 }, user), true);
  // A renamed account keeps the item; a matching login without an id does not
  // beat an id that disagrees.
  assert.equal(ownsStoreItem({ owner: { github_id: 1, github_login: 'quatrixone' } }, user), false);
  assert.equal(ownsStoreItem({ author: 'quatrixone' }, user), true);
});
```

Append to `backend/src/lib/marketplaceCatalog.test.js`:

```javascript
test('the default catalog is the marketplace repository and a missing manifest keeps the last copy', async () => {
  const { STORE_BASE } = await import('./marketplaceCatalog.js');
  assert.match(STORE_BASE, /^https:\/\/raw\.githubusercontent\.com\/quatrixone\/p5-marketplace\/main\/store\/$/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test backend/src/lib/storeOwnership.test.js backend/src/lib/marketplaceCatalog.test.js`
Expected: FAIL — `ownsStoreItem` ignores `owner`, and `STORE_BASE` still names `p5-manager`.

- [ ] **Step 3: Implement the minimal code**

`backend/src/lib/storeOwnership.js`:

```javascript
export function ownsStoreItem(item, user) {
  if (!item || !user) return false;
  const id = Number.isSafeInteger(item.owner?.github_id) ? item.owner.github_id
    : Number.isSafeInteger(item.github_owner_id) ? item.github_owner_id : null;
  if (id !== null) return id === user.id;
  return typeof item.author === 'string' && item.author.toLowerCase() === user.login.toLowerCase();
}
```

`backend/src/lib/storeItem.js:22`:

```javascript
export const STORE_REPO = 'quatrixone/p5-marketplace';
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test backend/src/lib/*.test.js`
Expected: PASS. Then confirm the live catalog answers:

```bash
curl -fsS https://raw.githubusercontent.com/quatrixone/p5-marketplace/main/store/builtin/inputScripts.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length,"curated scripts"))'
```

Expected: `6 curated scripts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/storeItem.js backend/src/lib/storeOwnership.js backend/src/lib/storeOwnership.test.js backend/src/lib/marketplaceCatalog.test.js
git commit -m "feat(store): read the catalog from the marketplace repository"
```

---

### Task 5: Drop the retail FPKGi categories

**Files:**
- Modify: `backend/src/lib/fpkgiCatalog.js:10-15` (the category list)
- Modify: `backend/src/lib/fpkgiCatalog.test.js:9-26` (the cases naming removed categories)
- Modify: `backend/src/lib/marketplaceNews.js:9-16` (prune snapshots of sources that are gone)
- Test: `backend/src/lib/marketplaceNews.test.js` (extend)
- Modify: `store/README.md` (the category sentence under "Full external catalog browser")

**Interfaces:**
- Consumes: nothing.
- Produces: `FPKGI_CATEGORIES` of three entries; `createMarketplaceNews({ file, collect, now, knownSource })` where `knownSource(sourceKey)` decides whether a persisted snapshot is still listed.

- [ ] **Step 1: Write the failing test**

In `backend/src/lib/fpkgiCatalog.test.js`, replace the first test's body and the `games` uses:

```javascript
test('only non-retail catalog categories are offered, and they map to PS4 and PS5 files', () => {
  assert.deepEqual(FPKGI_CATEGORIES.map(c => c.id), ['apps', 'homebrew', 'emulators']);
  for (const c of FPKGI_CATEGORIES) assert.ok(catalogPath('ps4', c.id).endsWith('.json'));
  assert.equal(catalogPath('ps5', 'homebrew'), 'ps5/ps5-homebrew.json');
  assert.equal(catalogPath('ps4', 'apps'), 'ps4/apps.json');
  for (const gone of ['games', 'updates', 'dlc', 'demos', 'themes', 'ps1', 'ps2', 'psp']) {
    assert.throws(() => catalogPath('ps4', gone), /Unknown/, `${gone} is no longer offered`);
  }
  assert.throws(() => catalogPath('ps4', '../../bad'), /Unknown/);
  assert.throws(() => catalogPath('ps3', 'homebrew'), /Unknown/);
});
```

and change the two `parseFpkgiCatalog(fixture, 'ps4', 'games')` calls in the next test to `'ps4', 'homebrew'`, leaving the assertions as they are.

Append to `backend/src/lib/marketplaceNews.test.js`:

```javascript
test('snapshots of sources that are no longer offered disappear from New', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'news-')), 'news.json');
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 1, warnings: [], records: {
    'fpkgi:ps4:games:a': { sourceKey: 'fpkgi:ps4:games', fingerprint: 'x', event: 'new', detectedAt: 1, item: { id: 'a', name: 'A retail game', console_type: 'ps4' } },
    'fpkgi:ps4:homebrew:b': { sourceKey: 'fpkgi:ps4:homebrew', fingerprint: 'y', event: 'new', detectedAt: 1, item: { id: 'b', name: 'A homebrew app', console_type: 'ps4' } },
  } }));
  const news = createMarketplaceNews({ file, now: () => 2, knownSource: (key) => key !== 'fpkgi:ps4:games',
    collect: async () => [{ key: 'fpkgi:ps4:homebrew', items: [{ id: 'b', name: 'A homebrew app', console_type: 'ps4' }] }] });
  const first = await news.page({});
  assert.deepEqual(first.items.map(i => i.name), ['A homebrew app']);
  assert.ok(!JSON.parse(fs.readFileSync(file, 'utf8')).records['fpkgi:ps4:games:a'], 'the snapshot is pruned on disk too');
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test backend/src/lib/fpkgiCatalog.test.js backend/src/lib/marketplaceNews.test.js`
Expected: FAIL — eleven categories are offered, and the retail snapshot is still listed.

- [ ] **Step 3: Implement the minimal code**

`backend/src/lib/fpkgiCatalog.js`:

```javascript
// Retail categories (games, updates, DLC, demos, themes, PS1, PS2, PSP) are
// deliberately not offered; the browser lists homebrew, applications and
// emulators only.
export const FPKGI_CATEGORIES = [
  ['apps', 'Applications'], ['homebrew', 'Homebrew'], ['emulators', 'Emulators'],
].map(([id, label]) => ({ id, label }));
export function catalogPath(platform, category) {
  if (!['ps4', 'ps5'].includes(platform) || !FPKGI_CATEGORIES.some(c => c.id === category)) throw Object.assign(new Error('Unknown platform or catalog category'), { status: 400 });
  return platform === 'ps4' ? `ps4/${category}.json` : `ps5/ps5-${category}.json`;
}
```

`backend/src/lib/marketplaceNews.js`, in `createMarketplaceNews`'s signature and loader:

```javascript
export function createMarketplaceNews({ file, collect, now = Date.now, knownSource = () => true }) {
  let records = {}, checkedAt = null, warnings = [], pending = null, started = false;
  try {
    const saved = decodeCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (saved.records && typeof saved.records === 'object' && !Array.isArray(saved.records)) {
      // A source we no longer collect would otherwise keep its entries for
      // ever, because only its own refresh can replace them.
      records = Object.fromEntries(Object.entries(saved.records).filter(([, r]) => knownSource(r?.sourceKey)));
    }
```

and pass the predicate where the news instance is created in `backend/src/routes/store.js:83`:

```javascript
  knownSource: (key) => key === 'marketplace' || ['ps4', 'ps5'].some(p => FPKGI_CATEGORIES.some(c => key === `fpkgi:${p}:${c.id}`)),
```

Pruned records must also be written back, so the first `refresh()` persists the filtered set — it already writes `{ ...records }`, so no further change is needed.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test backend/src/lib/*.test.js`
Expected: PASS.

- [ ] **Step 5: Update the documentation and commit**

In `store/README.md`, under "Full external catalog browser", replace the eleven-category sentence with:

```markdown
**Marketplace → FPKGi Catalog Hub** loads the Homebrew, Applications and
Emulators catalogs from Dinos17/FPKGi-Catalog-Hub for PS4 and PS5. Retail
categories are not offered.
```

```bash
git add backend/src/lib/fpkgiCatalog.js backend/src/lib/fpkgiCatalog.test.js backend/src/lib/marketplaceNews.js backend/src/lib/marketplaceNews.test.js backend/src/routes/store.js store/README.md
git commit -m "feat(store): the catalog browser offers no retail categories"
```

---

## Follow-ups, deliberately not in this plan

- The app repository's own `store/` folder becomes unread once Task 4 lands. Removing it is a separate change, kept apart so this one can be rolled back by reverting a single constant.
- The `triage` automation in `p5-marketplace` and the device-flow login with in-app upload are the next two plans, in that order, as the spec's order of work says.
