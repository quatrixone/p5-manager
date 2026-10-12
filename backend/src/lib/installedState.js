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

export function decorateInstalled(items, { installs = [], titles = null, takenAt = null } = {}) {
  const mine = new Map(installs.map((i) => [`${i.kind}:${i.store_id}`, i]));
  return items.map((item) => {
    const have = mine.get(`${item.kind}:${item.id}`);
    const id = item.kind === 'homebrew' ? homebrewTitleId(item) : null;
    const onConsole = titles ? (id ? titles.has(id) : null) : null;
    return {
      ...item,
      installed: have ? have.version : null,
      update: !!have && Number(item.version) > Number(have.version),
      onConsole,
      installedFrom: have ? 'records' : onConsole ? 'console' : null,
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
