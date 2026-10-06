// Pure helpers for the game Library (ShadowMountPlus API proxy): which
// storage a path lives on, the volumes worth showing, and where a game can
// be moved or copied to.

export const isValidTitleId = (id) => /^[A-Z]{4}\d{5}$/.test(String(id || ''));

// Absolute console path without traversal or control characters.
export function isSafeConsoleDir(p) {
  const s = String(p || '');
  if (!s.startsWith('/') || s.length > 512) return false;
  if (/[\x00-\x1f]/.test(s)) return false;
  return !s.split('/').some(seg => seg === '..' || seg === '.');
}

// Which physical storage a console path is on.
//   /data, /user            -> internal SSD (/data sits on the /user volume)
//   /mnt/ext0, /mnt/ext1    -> extended storage (M.2 / USB extended)
//   /mnt/usb0 .. /mnt/usb7  -> USB drive
export function storageOf(p) {
  const s = String(p || '');
  let m = /^\/mnt\/usb(\d)(\/|$)/.exec(s);
  if (m) return { id: `usb${m[1]}`, label: `USB ${m[1]}`, root: `/mnt/usb${m[1]}` };
  m = /^\/mnt\/ext(\d)(\/|$)/.exec(s);
  if (m) return { id: `ext${m[1]}`, label: m[1] === '1' ? 'Extended' : `Extended ${m[1]}`, root: `/mnt/ext${m[1]}` };
  if (/^\/(data|user)(\/|$)/.test(s)) return { id: 'internal', label: 'Internal', root: '/data' };
  return { id: 'other', label: 'Other', root: null };
}

// Volumes for the free-space bars, from ShadowMount's /storage mounts.
export function buildVolumes(mounts) {
  const out = [];
  for (const m of Array.isArray(mounts) ? mounts : []) {
    const mp = m.mount_point;
    const st = mp === '/user' ? storageOf('/data') : storageOf(mp);
    if (st.id === 'other' || (mp !== '/user' && mp !== st.root)) continue;
    if (out.some(v => v.id === st.id)) continue;
    out.push({
      id: st.id, label: st.label, path: st.root,
      total_bytes: m.total_bytes || 0, available_bytes: m.available_bytes || 0,
      read_only: !!m.read_only,
    });
  }
  const order = (v) => (v.id === 'internal' ? 0 : v.id.startsWith('ext') ? 1 : 2);
  return out.sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
}

// Where a game can be moved / copied: the homebrew folder of every writable
// volume, plus whatever ShadowMount itself suggests. USB 0 is always listed
// so it is clear why it cannot be picked while nothing is plugged in.
export function buildDestinations(volumes, apiDestinations) {
  const out = [];
  const add = (path, extra = {}) => {
    if (!isSafeConsoleDir(path) || out.some(d => d.path === path)) return;
    const st = storageOf(path);
    const vol = volumes.find(v => v.id === st.id);
    out.push({
      path, storage: st.id, label: st.label,
      available_bytes: vol ? vol.available_bytes : null,
      connected: !!vol && !vol.read_only,
      ...extra,
    });
  };
  for (const v of volumes) add(`${v.path}/homebrew`);
  if (!volumes.some(v => v.id === 'usb0')) add('/mnt/usb0/homebrew');
  for (const d of Array.isArray(apiDestinations) ? apiDestinations : []) {
    if (d && d.path && !d.read_only) add(d.path);
  }
  return out;
}
