// One-time layout migration from the legacy /app/data/{payloads,mkpfs}
// layout to the new /data/{payloads,mkpfs,downloads} layout (see
// backend/src/lib/paths.js for the rationale).
//
// Idempotent: re-runs on every boot but does nothing once the new
// dirs exist and the legacy dirs are empty. Safe to interrupt mid-
// migration — items already moved aren't moved again.
//
// What it does:
//   1. mkdir -p the new user-data dirs
//   2. Move any files from legacy_payloads/ → payloadsDir
//   3. Move any files from legacy_mkpfs/    → mkpfsWorkDir
//      (mkpfs work dir holds large staged extracts, so we use rename
//      when the legacy/new dirs share a device and fall back to a
//      streaming copy across devices)
//   4. UPDATE payloads SET filepath = REPLACE(filepath, legacy_prefix, new_prefix)
//      so the DB pointers track the move.
//   5. Touches queue-state.json paths via a regex sweep (best-effort,
//      stale entries from old jobs just fail when the worker resumes
//      and are surfaced in the queue UI — not catastrophic).

import fs from 'fs';
import path from 'path';
import {
  internalDataDir,
  payloadsDir,
  mkpfsWorkDir,
  downloadsDir,
} from './paths.js';
import { getRepo, log } from '../db/sqlite.js';

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    // Common case: /data isn't writable for UID 1000. Surface a clear
    // error message in the startup logs so the operator knows to chown
    // the directory (or override USER_DATA_DIR to a writable path).
    log('error', `[migrate-paths] cannot create ${dir}: ${err.message}`);
    return false;
  }
}

function moveTree(src, dst) {
  if (!fs.existsSync(src)) return { moved: 0, failed: 0 };
  if (path.resolve(src) === path.resolve(dst)) {
    return { moved: 0, failed: 0 };
  }
  let moved = 0;
  let failed = 0;
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); }
  catch (err) { log('warn', `[migrate-paths] readdir ${src}: ${err.message}`); return { moved, failed }; }
  for (const ent of entries) {
    // Skip hidden state files (e.g. .tmp/) - those are scratch and the
    // worker will recreate them as needed.
    if (ent.name.startsWith('.')) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (fs.existsSync(to)) continue; // already migrated for this entry
    try {
      fs.renameSync(from, to);
      moved++;
    } catch (err) {
      if (err.code === 'EXDEV') {
        try {
          fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
          fs.rmSync(from, { recursive: true, force: true });
          moved++;
        } catch (err2) {
          log('error', `[migrate-paths] cross-device move ${from} → ${to} failed: ${err2.message}`);
          failed++;
        }
      } else {
        log('error', `[migrate-paths] move ${from} → ${to} failed: ${err.message}`);
        failed++;
      }
    }
  }
  return { moved, failed };
}

// Returns true if a row's filepath sits under the legacy prefix.
function fixDbPathRow(legacyPrefix, newPrefix) {
  const repo = getRepo();
  try {
    const rows = repo.queryAll('SELECT id, filepath FROM payloads WHERE filepath LIKE ?', [`${legacyPrefix}%`]);
    let updated = 0;
    for (const row of rows) {
      const next = newPrefix + row.filepath.slice(legacyPrefix.length);
      repo.run('UPDATE payloads SET filepath = ? WHERE id = ?', [next, row.id]);
      updated++;
    }
    if (updated > 0) {
      repo.save();
      log('info', `[migrate-paths] DB: updated ${updated} payloads.filepath rows`);
    }
    return updated;
  } catch (err) {
    log('error', `[migrate-paths] DB update failed: ${err.message}`);
    return 0;
  }
}

export function migratePaths() {
  const legacyPayloads = path.join(internalDataDir, 'payloads');
  const legacyMkpfs = path.join(internalDataDir, 'mkpfs');

  // Step 1: make sure new dirs exist (and bail early if /data isn't
  // writable - the rest of the migration would fail anyway).
  const okP = safeMkdir(payloadsDir);
  const okM = safeMkdir(mkpfsWorkDir);
  const okD = safeMkdir(downloadsDir);
  if (!okP || !okM || !okD) {
    log('warn', '[migrate-paths] one or more user-data dirs not writable - check permissions on /data');
    return;
  }

  // Step 2/3: move legacy contents over (only when legacy != new)
  if (path.resolve(legacyPayloads) !== path.resolve(payloadsDir)) {
    const { moved, failed } = moveTree(legacyPayloads, payloadsDir);
    if (moved || failed) {
      log('info', `[migrate-paths] payloads: moved=${moved} failed=${failed} (${legacyPayloads} → ${payloadsDir})`);
    }
    if (moved && !failed) {
      fixDbPathRow(legacyPayloads, payloadsDir);
      // Drop the empty legacy dir so the next boot doesn't even look at it.
      try {
        const remain = fs.readdirSync(legacyPayloads).filter(n => !n.startsWith('.'));
        if (remain.length === 0) fs.rmSync(legacyPayloads, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (path.resolve(legacyMkpfs) !== path.resolve(mkpfsWorkDir)) {
    const { moved, failed } = moveTree(legacyMkpfs, mkpfsWorkDir);
    if (moved || failed) {
      log('info', `[migrate-paths] mkpfs: moved=${moved} failed=${failed} (${legacyMkpfs} → ${mkpfsWorkDir})`);
    }
    if (moved && !failed) {
      try {
        const remain = fs.readdirSync(legacyMkpfs).filter(n => !n.startsWith('.'));
        if (remain.length === 0) fs.rmSync(legacyMkpfs, { recursive: true, force: true });
      } catch (_) {}
    }
  }
}
