// Picks the app bundle to offer out of the release that carries them.
//
// The bundles are not attached to a version's own release: they sit in one
// release tagged `updates`, so that a version's page lists only what people
// download. That release says nothing about the version, so it is read from
// the bundle names - the newest one for this platform wins, and only a
// bundle whose checksum is already there counts (the two are uploaded one
// after the other).

export const BUNDLE_NAME = /^p5-manager-app-(\d[0-9A-Za-z.]*)-(docker|windows)-level(\d+)-deps([0-9a-f]{12})(?:-py([0-9a-f]{12}))?\.zip$/;

const parseVersion = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
export function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

// assets: the `assets` of a GitHub release. Returns { version, bundle }, or
// null when there is nothing for this platform.
export function pickBundle(assets, platform) {
  const list = Array.isArray(assets) ? assets : [];
  let best = null;
  for (const zip of list) {
    const m = String(zip?.name || '').match(BUNDLE_NAME);
    if (!m || m[2] !== platform) continue;
    const sum = list.find(a => a?.name === `${zip.name}.sha256`);
    if (!sum) continue;
    if (best && !isNewerVersion(m[1], best.version)) continue;
    best = {
      version: m[1],
      bundle: {
        name: zip.name,
        url: zip.browser_download_url,
        sha256_url: sum.browser_download_url,
        size: zip.size,
        image_level: parseInt(m[3], 10),
        deps: m[4],
        pydeps: m[5] || '',
      },
    };
  }
  return best;
}
