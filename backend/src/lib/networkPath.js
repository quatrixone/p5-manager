// A network folder as people have it at hand: copied from Explorer's address
// bar (\\nas\games\ps5), from a Linux file manager (smb://nas/games/ps5) or
// typed with forward slashes. Returns { host, share, subPath } - subPath
// with forward slashes and no slash at either end - or null when the text
// names no server and share.
export function parseNetworkPath(text) {
  let s = String(text || '').trim().replace(/^"(.*)"$/, '$1').trim();
  s = s.replace(/^smb:/i, '').replace(/\\/g, '/');
  if (!s.startsWith('//')) return null;
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [host, share, ...rest] = parts;
  if (/[<>:"|?*]/.test(share) || /[\s<>"|?*]/.test(host)) return null;
  return { host, share, subPath: rest.join('/') };
}

// \\host\share[\sub\path], the form Windows opens.
export function toUncPath({ host, share, subPath = '' }) {
  return `\\\\${host}\\${share}${subPath ? '\\' + subPath.replace(/\//g, '\\') : ''}`;
}
