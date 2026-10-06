// Pure path helpers for the transfer queue (dual-pane file manager). All
// paths are POSIX-style: the same code serves server paths and paths on a
// console's FTP server.

// Collapse duplicate slashes and drop the trailing one ("/" stays "/").
export function cleanDir(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  if (s === '' || s === '/') return '/';
  return s.replace(/\/$/, '');
}

export function joinPath(base, name) {
  const b = cleanDir(base);
  const n = String(name || '').replace(/^\/+/, '');
  return b === '/' ? `/${n}` : `${b}/${n}`;
}

// True when `child` is `parent` itself or lies anywhere below it.
export function isSameOrInside(parent, child) {
  const p = cleanDir(parent);
  const c = cleanDir(child);
  if (p === c) return true;
  return c.startsWith(p === '/' ? '/' : `${p}/`);
}

// Directory a file ends up in when folder `baseName` is dropped onto
// `destBase` and the file sits at `relPath` inside that folder.
export function destDirFor(destBase, baseName, relPath) {
  const root = joinPath(destBase, baseName);
  const rel = String(relPath || '').replace(/\\/g, '/');
  const idx = rel.lastIndexOf('/');
  return idx <= 0 ? root : joinPath(root, rel.slice(0, idx));
}
