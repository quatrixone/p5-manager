// Picks the asset of a new GitHub release that replaces an installed
// payload file. Release assets usually carry the version in their name
// (zftpd-ps5-v1.5.0.elf -> zftpd-ps5-v1.6.0.elf), so an exact-name match is
// not enough - but grabbing "the first .elf" is how a PS5 payload ended up
// replaced by the PS4 build of the same release.

// "zftpd-ps5-v1.5.0.elf" -> "zftpd-ps5.elf", "smp-1.7beta3.elf" -> "smp.elf"
export function stripVersion(name) {
  return String(name || '').toLowerCase().replace(/[-_.]?v?\d+(?:\.\d+)+[a-z0-9]*/g, '');
}

export function platformOf(name) {
  if (/ps5|prospero/i.test(name)) return 'ps5';
  if (/ps4|orbis/i.test(name)) return 'ps4';
  return null;
}

const extOf = (name) => {
  const m = /\.[a-z0-9]+$/i.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
};

// Returns the asset object or null when nothing in the release is a safe
// replacement (the caller reports that instead of guessing).
export function pickReleaseAsset(assets, oldName) {
  const list = Array.isArray(assets) ? assets : [];
  const exact = list.find(a => a.name === oldName);
  if (exact) return exact;

  const wanted = stripVersion(oldName);
  const sameIgnoringVersion = list.find(a => stripVersion(a.name) === wanted);
  if (sameIgnoringVersion) return sameIgnoringVersion;

  // Looser fallbacks never cross platforms: a file named for one console is
  // only replaced by an asset named for the same console, or by one that
  // names none.
  const platform = platformOf(oldName);
  const compatible = list.filter(a => {
    const p = platformOf(a.name);
    return p === platform || p === null;
  });
  const ext = extOf(oldName);
  const sameExt = compatible.filter(a => extOf(a.name) === ext);
  if (sameExt.length === 1) return sameExt[0];
  if (sameExt.length > 1) return null; // ambiguous - do not guess
  const zips = compatible.filter(a => extOf(a.name) === '.zip');
  return zips.length === 1 ? zips[0] : null;
}

// Display name after an update: follows the file when it was just the old
// file name (with or without extension); custom names are kept.
export function renamedDisplayName(oldDisplay, oldFile, newFile) {
  if (!oldDisplay || !oldFile || oldFile === newFile) return oldDisplay;
  if (oldDisplay === oldFile) return newFile;
  const noExt = (n) => n.replace(/\.[a-z0-9]+$/i, '');
  if (oldDisplay === noExt(oldFile)) return noExt(newFile);
  return oldDisplay;
}
