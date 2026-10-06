// Decides how a drop from one file-browser pane onto another is carried
// out. A location is { kind: 'local' | 'smb' | 'ftp', ftpIp, smbId, path }.
//   noop         same folder of the same store - nothing to do
//   unsupported  see `reason`
//   ftp-rename   instant rename on one console          (/convert/ftp/move)
//   local-copy   synchronous copy on the server disk    (/convert/local/copy)
//   local-move   synchronous move on the server disk    (/convert/local/move)
//   queue        server-side transfer queue             (/convert/transfer/queue)

const norm = (p) => {
  const s = String(p || '').replace(/\/+/g, '/').replace(/\/$/, '');
  return s === '' ? '/' : s;
};

export function sameStore(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'local') return true;
  if (a.kind === 'ftp') return !!a.ftpIp && a.ftpIp === b.ftpIp;
  return String(a.smbId || '') !== '' && String(a.smbId) === String(b.smbId);
}

export function planTransfer(src, dst, op) {
  if (!src || !dst) return { route: 'unsupported', reason: 'Open a folder in both panes first' };
  if (dst.kind === 'smb') {
    return { route: 'unsupported', reason: 'Remote sources are read-only - pick the server disk or a console as the destination' };
  }
  if (dst.kind === 'ftp' && !dst.ftpIp) return { route: 'unsupported', reason: 'Pick a console in the destination pane' };
  if (sameStore(src, dst) && norm(src.path) === norm(dst.path)) return { route: 'noop' };
  if (src.kind === 'local' && dst.kind === 'local') return { route: op === 'move' ? 'local-move' : 'local-copy' };
  if (src.kind === 'ftp' && dst.kind === 'ftp' && src.ftpIp === dst.ftpIp && op === 'move') return { route: 'ftp-rename' };
  return { route: 'queue' };
}
