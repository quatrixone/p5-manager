// Fingerprint of the installed dependencies, taken from package-lock.json
// with the app's own version left out (it changes with every release while
// the dependencies stay the same).
//
// An in-app update brings new code but no node_modules: it runs on the ones
// in the image. src/index.js therefore only loads a downloaded copy whose
// fingerprint matches the image's, and scripts/build-app-bundle.mjs writes
// the fingerprint into the bundle's name and manifest.
import fs from 'fs';
import crypto from 'crypto';

export function depsHash(lockFile) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return crypto.createHash('sha256').update(JSON.stringify(lock)).digest('hex').slice(0, 12);
}
