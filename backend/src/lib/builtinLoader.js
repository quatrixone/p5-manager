// Resolves /frontend/builtin/ from the backend, in both layouts:
//
//   * Dev / repo checkout: backend/src/lib/  →  ../../../frontend/builtin
//   * Docker image:        /app/src/lib/     →  ../../builtin   (Dockerfile
//                                                copies frontend/builtin
//                                                to /app/builtin)
//
// Each loaded module is cached by absolute path so consumers don't pay the
// dynamic-import cost on hot endpoints.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_DIRS = [
  // Repo / `npm run dev` layout
  path.resolve(__dirname, '../../../frontend/builtin'),
  // Docker runtime layout (see Dockerfile)
  path.resolve(__dirname, '../../builtin'),
  // Allow override for unusual deployments
  process.env.BUILTIN_DIR && path.resolve(process.env.BUILTIN_DIR),
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

// mtime-keyed cache. When the user edits a builtin file via the editor API,
// the mtime advances and we transparently re-import on the next request.
// We append ?v=<mtimeMs> to the file URL so Node's internal ESM loader treats
// each version as a fresh module specifier (otherwise it would hand back the
// cached one regardless of disk state).
const moduleCache = new Map(); // filePath -> { mtimeMs, mod }

export async function loadBuiltin(filename) {
  const dir = getBuiltinDir();
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Built-in module not found: ${filePath}`);
  }
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = moduleCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.mod;

  const url = pathToFileURL(filePath).href + `?v=${mtimeMs}`;
  const mod = await import(url);
  moduleCache.set(filePath, { mtimeMs, mod });
  return mod;
}

export function clearBuiltinCache(filename) {
  if (!filename) {
    moduleCache.clear();
    return;
  }
  const dir = getBuiltinDir();
  moduleCache.delete(path.join(dir, filename));
}
