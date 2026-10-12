// What the user already has. Two sources answer that, and they answer
// different halves of it: our own store_installs rows know which version of
// a Marketplace item was installed, the console's Library knows what is
// actually on it - including what someone installed without us. A console
// that is off still answers, from the last snapshot, with the time it was
// taken so the UI can say how old the answer is.
import fs from 'node:fs';
import path from 'node:path';
import { internalDataDir } from './paths.js';

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

export function titleIdsOf(library) {
  const ids = new Set();
  for (const game of library?.games || []) {
    const id = String(game?.title_id || game?.titleId || '').toUpperCase();
    if (TITLE_ID.test(id)) ids.add(id);
  }
  return ids;
}

// The title id a homebrew item installs as: either declared, or the one
// Sony's package naming puts in the file name (IV0000-CHTM00777_00-…).
export function homebrewTitleId(item) {
  const declared = String(item.homebrew_id || '').toUpperCase();
  if (TITLE_ID.test(declared)) return declared;
  for (const file of item.files || []) {
    const m = /[A-Z]{2}\d{4}-([A-Z]{4}\d{5})_/i.exec(String(file?.name || ''));
    if (m) return m[1].toUpperCase();
  }
  return null;
}

// A catalog package is recorded under its origin, because the same id can
// exist in two catalogs; everything else is keyed by kind and store id.
export const installKey = (item) => (item.kind === 'catalog' ? `catalog:${item.origin}:${item.id}` : `${item.kind}:${item.id}`);

// Version strings here are whatever an author wrote: "1.11", "v1.09",
// "1.6beta16", or nothing at all. Compare the numbers and admit when
// there is nothing to compare, rather than inventing an update.
export function compareVersions(a, b) {
  const parts = (v) => String(v || '').trim().replace(/^v+/i, '').match(/\d+/g)?.map(Number) || null;
  const left = parts(a), right = parts(b);
  if (!left || !right) return null;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const d = (left[i] || 0) - (right[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// What the user already has outside the Marketplace: a payload file in the
// library, a script in My Scripts, a saved Autoload sequence. Matched by
// the name the store item installs under, which is what the user sees.
export function localIndex({ payloads = [], scripts = [], sequences = [] } = {}) {
  const name = (v) => String(v || '').trim().toLowerCase();
  const row = (r) => ({ name: r.filename || r.name, version: r.version || null });
  return {
    payload: new Map(payloads.map((p) => [name(p.filename || p.name), row(p)])),
    script: new Map(scripts.map((s) => [name(s.name), row(s)])),
    template: new Map(sequences.map((q) => [name(q.name), row(q)])),
    // A payload the user renamed is still that payload, so the checksum
    // decides before the name does.
    bySha: new Map(payloads.filter((p) => /^[a-f0-9]{64}$/i.test(String(p.sha256 || ''))).map((p) => [String(p.sha256).toLowerCase(), row(p)])),
  };
}

export function decorateInstalled(items, { installs = [], titles = null, takenAt = null, local = null } = {}) {
  const mine = new Map(installs.map((i) => [`${i.kind}:${i.store_id}`, i]));
  return items.map((item) => {
    const have = mine.get(installKey(item));
    const id = item.kind === 'homebrew' ? homebrewTitleId(item) : null;
    const onConsole = titles ? (id ? titles.has(id) : null) : null;
    const here = local?.[item.kind];
    const key = String(item.name || '').trim().toLowerCase();
    const sum = String(item.sha256 || '').toLowerCase();
    const match = (sum && local?.bySha?.get(sum)) || here?.get(key) || null;
    const inLibrary = !!match;
    const localVersion = match?.version || null;
    const localName = match?.name || null;
    // Our own record knows which store revision was installed. Without one,
    // a copy already in the library is "installed", and only a newer app
    // version in the listing makes it an update.
    const update = have
      ? Number(item.version) > Number(have.version)
      : inLibrary && compareVersions(item.app_version, localVersion) === 1;
    return {
      ...item,
      installed: have ? have.version : null,
      update,
      onConsole,
      inLibrary,
      localVersion,
      localName,
      installedFrom: have ? 'records' : onConsole ? 'console' : inLibrary ? 'library' : null,
      libraryTakenAt: onConsole ? takenAt : null,
    };
  });
}

export function createLibrarySnapshots({ dir = path.join(internalDataDir, 'marketplace'), now = Date.now } = {}) {
  const file = (profileId) => path.join(dir, `library-${String(profileId).replace(/[^0-9a-z]/gi, '')}.json`);
  return {
    write(profileId, library) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const data = { takenAt: new Date(now()).toISOString(), titles: [...titleIdsOf(library)] };
        fs.writeFileSync(`${file(profileId)}.tmp`, JSON.stringify(data));
        fs.renameSync(`${file(profileId)}.tmp`, file(profileId));
      } catch { /* A snapshot is a convenience; never fail a Library read for it. */ }
    },
    read(profileId) {
      try {
        const data = JSON.parse(fs.readFileSync(file(profileId), 'utf8'));
        return { titles: new Set(data.titles || []), takenAt: data.takenAt || null };
      } catch { return null; }
    },
  };
}

export const librarySnapshots = createLibrarySnapshots();
