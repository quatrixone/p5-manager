// Path helpers for paths shown in the UI. Server paths are POSIX on the
// Docker/Linux build and 'C:/Users/x' (forward slashes) on the portable
// Windows build; console and remote paths are always POSIX.

// Absolute path on either kind of host: '/x', 'C:/x', 'C:\x', '//nas/share'.
export const isAbsPath = (p) => /^([A-Za-z]:)?[\\/]/.test(String(p || ''));

// Breadcrumbs for a path. 'C:/Users/me' -> C: (C:/), Users (C:/Users), me.
export function crumbsOf(p) {
  const s = String(p || '');
  if (!s) return [];
  const parts = s.split('/').filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] || '');
  const crumbs = [];
  let acc = '';
  parts.forEach((part, i) => {
    if (i === 0 && drive) acc = part;
    else acc += `/${part}`;
    // A bare 'C:' means "current folder on C:" to Windows - the root is 'C:/'.
    crumbs.push({ label: part, path: i === 0 && drive ? `${part}/` : acc });
  });
  return crumbs;
}
