// Resolves /frontend/builtin/ from the backend, in both layouts:
//
//   * Dev / repo checkout: backend/src/lib/  →  ../../../frontend/builtin
//   * Docker image:        /app/src/lib/     →  ../../builtin   (Dockerfile
//                                                copies frontend/builtin
//                                                to /app/builtin)
//

import fs from 'fs';
import { decodeCatalog } from './catalogLinks.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_DIRS = [
  process.env.BUILTIN_DIR && path.resolve(process.env.BUILTIN_DIR),
  // Repo / `npm run dev` layout
  path.resolve(__dirname, '../../../frontend/builtin'),
  // Docker runtime layout (see Dockerfile)
  path.resolve(__dirname, '../../builtin'),
].filter(Boolean);

let cachedDir = null;

export function getBuiltinDir() {
  if (cachedDir) return cachedDir;
  for (const dir of CANDIDATE_DIRS) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        cachedDir = dir;
        return dir;
      }
    } catch (_) {}
  }
  // Fall through to the first candidate so error messages point at the
  // expected dev location.
  cachedDir = CANDIDATE_DIRS[0];
  return cachedDir;
}

// The built-in files are JSON arrays. Each is read again only when its
// mtime moves, so an edit through the editor API shows on the next request.
const cache = new Map(); // filePath -> { mtimeMs, list }

export function readBuiltinList(filename) {
  const filePath = path.join(getBuiltinDir(), filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Built-in file not found: ${filePath}`);
  }
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = cache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.list;
  const list = decodeCatalog(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  if (!Array.isArray(list)) throw new Error(`${filename} is not a JSON array`);
  cache.set(filePath, { mtimeMs, list });
  return list;
}
