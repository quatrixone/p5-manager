// What a Marketplace card says and offers. Kept here, away from JSX, so
// the rules are testable: the list, the detail panel and the New feed all
// read the same answer for the same item.

export const KIND_LABEL = {
  payload: 'Payload', homebrew: 'Homebrew', template: 'Autoload template',
  script: 'Input script', catalog: 'Catalog package',
};
export const KIND_ICON = { homebrew: '🎮', payload: '📦', script: '🕹️', template: '⚡', catalog: '💿' };

// Which items cannot be put anywhere without a console answering.
export function needsConsole(item) {
  if (item.kind === 'catalog') return true;
  if (item.kind === 'homebrew') return (item.files || []).includes('pkg');
  if (item.kind === 'template') return item.requiresProfile !== false;
  return false;
}

// The primary button: what it says, what it does, and why it cannot.
// `consoleOnline` is null while we do not know yet, which never disables.
export function actionFor(item, { consoleOnline = null, hasProfile = true } = {}) {
  if (item.kind === 'catalog' && !item.installable) {
    return { action: 'link', label: 'Open package link', disabled: !item.package_url, reason: item.package_url ? '' : 'This listing has no usable link' };
  }
  const label = item.update ? 'Update' : item.installed || item.onConsole ? 'Install again' : 'Install';
  const action = item.kind === 'catalog' ? 'install-catalog' : 'install';
  if (!needsConsole(item)) return { action, label, disabled: false, reason: '' };
  if (!hasProfile) return { action, label, disabled: true, reason: `No ${(item.console_type || 'console').toUpperCase()} profile to install it on` };
  if (consoleOnline === false) return { action, label, disabled: true, reason: 'The console is not on' };
  return { action, label, disabled: false, reason: '' };
}

// What the card shows about having it already, and where that is known from.
export function installedBadge(item) {
  if (item.update) return { text: `Update v${item.version}`, tone: 'warning', title: `Installed: v${item.installed}` };
  if (item.installed) return { text: '✓ Installed', tone: 'success', title: `Installed by P5 Manager (v${item.installed})` };
  if (item.onConsole) {
    const when = item.libraryTakenAt ? new Date(item.libraryTakenAt).toLocaleString() : null;
    return { text: '✓ On console', tone: 'success', title: when ? `Seen in the console library on ${when}` : 'Seen in the console library' };
  }
  return null;
}

// A catalog package without a checksum is worth saying out loud, once on
// the card and once in the confirmation.
export function unverifiedWarning(item) {
  return item.kind === 'catalog' && item.installable && !item.verified
    ? 'This source gives no SHA-256, so the package cannot be checked before it is installed.'
    : '';
}

export const sizeLabel = (n) => (n ? (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`) : '');
