// What the engine's game, job and history data mean on screen.

export const ACTION_LABEL = {
  'compress': 'Compress',
  'make-image': 'Make Image',
  'uncompress': 'Uncompress',
  'validate-repair': 'Validate and Repair',
  'validate-only': 'Validate Only',
  'lz4-pack': 'Compress with LZ4',
  'lz4-unpack': 'Uncompress LZ4',
  'lz4-verify': 'Verify LZ4 Packs',
  'verify-game': 'Verify Game Files',
  'build-ampr-index': 'Build AMPR Index',
  'set-read-only': 'Set Read Only',
  'extract-image': 'Extract to Folder',
  'refresh-mount': 'Mount Now',
  'read-speed-test': 'Test Read Speed',
  'update-ampr': 'Update APR-EMU',
  'restore-ampr-original': 'Restore Original APR-EMU',
  'copy-to': 'Copy to…',
  'move-to': 'Move to…',
  'delete-game-data': 'Delete Game Data',
  'move-to-usb': 'Move to USB',
  'move-to-internal': 'Move to Internal',
  'copy-to-usb': 'Copy to USB',
  'copy-to-internal': 'Copy to Internal',
  'report-compat': 'Report how it runs',
};

export const ACTION_DESC = {
  'compress': 'Pack the game into a compressed .ffpfsc image.',
  'lz4-pack': 'Seekable LZ4 packs read while the game runs. APR-EMU is added if the game has none.',
  'make-image': 'Build a plain .exfat or .ffpfs image from this folder.',
  'validate-only': 'Read every block and report problems without changing anything.',
  'validate-repair': 'Read every block and repair what it can.',
  'lz4-verify': 'Check every LZ4 pack block and put back files the game needs to boot.',
  'verify-game': 'Fix what stops a folder from booting: PlayGo, runtime name, file index, permissions.',
  'read-speed-test': 'Read the game for a minute and measure the speed.',
  'uncompress': 'Turn the compressed image back into an image or a folder.',
  'lz4-unpack': 'Put the normal loose files back from the LZ4 packs.',
  'extract-image': 'Copy the image out to a normal folder.',
  'set-read-only': 'Mount this image read-only in ShadowMount+.',
  'refresh-mount': 'Ask ShadowMount+ to mount this copy now.',
  'restore-ampr-original': 'Put back the APR-EMU file the game came with.',
  'build-ampr-index': 'Build the path index APR-EMU uses to find files fast.',
  'update-ampr': 'Install the latest APR-EMU build.',
  'copy-to': 'Copy the game to internal storage or a USB drive.',
  'move-to': 'Move the game to internal storage or a USB drive.',
  'delete-game-data': 'Permanently delete this copy of the game.',
  'report-compat': 'Tell others if it works after packing.',
};

export const ACTION_ICON = {
  'compress': 'compress', 'lz4-pack': 'bolt', 'make-image': 'disc', 'validate-only': 'shield',
  'validate-repair': 'shield', 'lz4-verify': 'shield', 'verify-game': 'shield', 'read-speed-test': 'gauge', 'uncompress': 'expand',
  'lz4-unpack': 'expand', 'extract-image': 'folder', 'set-read-only': 'lock', 'refresh-mount': 'mount',
  'restore-ampr-original': 'undo', 'build-ampr-index': 'list', 'update-ampr': 'download',
  'copy-to': 'copy', 'move-to': 'move', 'delete-game-data': 'trash', 'report-compat': 'check',
};

export const GROUPS = [
  ['compress', 'Compress', ['compress', 'lz4-pack', 'make-image']],
  ['check', 'Check', ['validate-only', 'validate-repair', 'lz4-verify', 'verify-game', 'read-speed-test']],
  ['community', 'Community', ['report-compat']],
  ['restore', 'Restore', ['uncompress', 'lz4-unpack', 'extract-image', 'set-read-only', 'refresh-mount']],
  ['ampr', 'APR-EMU', ['update-ampr', 'restore-ampr-original', 'build-ampr-index']],
  ['storage', 'Copy and move', ['copy-to', 'move-to']],
  ['danger', 'Delete', ['delete-game-data']],
];

// Actions that open a page of choices instead of starting straight away.
export const ACTION_PAGES = {
  'compress': 'compress', 'make-image': 'compress', 'lz4-pack': 'lz4', 'lz4-unpack': 'lz4',
  'uncompress': 'uncompress', 'copy-to': 'move', 'move-to': 'move', 'delete-game-data': 'delete',
  'report-compat': 'report',
};

const kindOf = game => String((game && game.sourceKind) || '').toLowerCase();

export function onDemand(game) {
  return !!game && game.isMounted === false && String(game.mountStatus || '').toLowerCase() === 'on-demand';
}

function baseAction(game) {
  if (!game || !game.sourcePath) return '';
  const kind = kindOf(game);
  // Glacier games can't start from packs, so unpacking comes first.
  if (game.lz4Packed === true && kind === 'folder') return game.lz4DiskPackages === true ? 'lz4-unpack' : 'lz4-verify';
  if (kind === 'compressed') return 'validate-repair';
  if (kind === 'folder' || kind === 'image') return 'compress';
  return '';
}

// LZ4 is the main action for every game that can use it (it imports AMPR,
// with or without APR-EMU); .ffpfsc is the fallback.
function lz4First(game) {
  if (!game || game.lz4Packed === true || game.lz4Supported !== true) return false;
  return ['folder', 'image', 'compressed'].includes(kindOf(game));
}

export function primaryAction(game) {
  if (lz4First(game)) return 'lz4-pack';
  if (game && game.amprUpdateNeeded === true && game.amprLatestVersion && game.amprLatestSha256) return 'update-ampr';
  return baseAction(game);
}

function amprCanRestoreOriginal(game) {
  if (!game || game.amprOriginalAvailable !== true || game.amprPresent !== true) return false;
  const current = String(game.amprSha256 || '').toLowerCase();
  const original = String(game.amprOriginalSha256 || '').toLowerCase();
  return !current || !original || current !== original;
}

export function secondaryActions(game) {
  if (!game || !game.sourcePath || game.activeOp || game.pendingOp || kindOf(game) === 'unknown') return [];
  const kind = kindOf(game);
  const packed = game.lz4Packed === true;
  const canIndex = game.amprPresent === true && !packed;
  const primary = primaryAction(game);
  const normal = baseAction(game);
  const mountedOrOnDemand = game.isMounted === true || onDemand(game);
  const ids = [];
  if ((primary === 'update-ampr' || primary === 'lz4-pack') && normal) ids.push(normal);
  if (primary === 'lz4-pack' && game.amprUpdateNeeded === true && game.amprLatestVersion) ids.push('update-ampr');
  if (amprCanRestoreOriginal(game) && !packed) ids.push('restore-ampr-original');
  if (game.lz4Supported === true) ids.push('lz4-pack');
  if (packed) {
    if (primary !== 'lz4-verify') ids.push('lz4-verify');
    ids.push('lz4-unpack');
    ids.push('report-compat');
  }
  if (kind === 'folder') {
    if (!packed) ids.push('verify-game');
    ids.push('make-image');
    if (canIndex) ids.push('build-ampr-index');
  }
  if (kind === 'compressed' || primary === 'validate-repair') {
    ids.push('validate-only');
    if (canIndex) ids.push('build-ampr-index');
    ids.push('uncompress');
  }
  if (kind === 'image') {
    ids.push('set-read-only');
    if (canIndex) ids.push('build-ampr-index');
    if (mountedOrOnDemand) ids.push('extract-image');
  }
  if (game.isMounted === false && kind !== 'folder') ids.push('refresh-mount');
  if (mountedOrOnDemand) ids.push('read-speed-test');
  if (game.canMoveToUsb || game.canMoveToInternal) ids.push('copy-to', 'move-to');
  ids.push('delete-game-data');
  return [...new Set(ids)].filter(id => id !== primary);
}

// Which TOML "Compress with LZ4" uses for this game by default.
export function profileText(game) {
  if (game.lz4ProfileAvailable) return 'Imported config';
  const auto = game.lz4AutoProfile;
  if (auto) return auto.match === 'title' ? auto.label : `${auto.label} (same engine)`;
  return 'Automatic scan';
}

// Engine errors carry raw byte counts ("free 12005212160 more bytes").
export function readableError(text) {
  return String(text || '')
    .replace(/\b(\d{1,20})\s+more\s+bytes?\b/gi, (match, value) => `${formatBytes(Number(value))} more`)
    .replace(/\b(\d{1,20})\s+bytes?\b/gi, (match, value) => formatBytes(Number(value)));
}

export function formatBytes(bytes) {
  let value = Number(bytes || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return (unit === 0 ? value.toFixed(0) : value.toFixed(value >= 100 ? 0 : 1)) + ' ' + units[unit];
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function storageLabel(game) {
  const path = String((game && game.sourcePath) || '');
  if (path.startsWith('/data/')) return 'Internal SSD';
  const usb = /^\/mnt\/usb(\d)/.exec(path);
  if (usb) return `USB ${usb[1]}`;
  if (path.startsWith('/mnt/ext1')) return 'M.2 SSD';
  if (path.startsWith('/mnt/ext0')) return 'Extended storage';
  return (game && game.storage) || 'Storage';
}

export function kindLabel(game) {
  const kind = kindOf(game);
  const path = String((game && game.sourcePath) || '').toLowerCase();
  if (kind === 'folder') return game.lz4Packed ? 'Folder with LZ4 packs' : 'Folder';
  if (kind === 'compressed') return 'Compressed .ffpfsc';
  if (kind === 'image') return path.endsWith('.ffpfs') ? 'PFS image' : 'exFAT image';
  return 'Unknown';
}

export function badgeText(game) {
  if (game.lz4Packed) return 'LZ4';
  if (game.pendingOp) return 'QUEUED';
  const ext = /\.([a-z0-9]+)$/i.exec(String(game.sourcePath || ''));
  if (kindOf(game) === 'folder') return 'FOLDER';
  if (ext) return ext[1].toUpperCase();
  return '';
}

export function gameSize(game) {
  if (kindOf(game) === 'compressed' && game.compressedSize) return formatBytes(game.compressedSize);
  if (game.sourceSize) return (game.sizeEstimated ? '~' : '') + formatBytes(game.sourceSize);
  return '…';
}

const PHASE_LABEL = {
  'lz4-pack': 'Packing with LZ4', 'lz4-unpack': 'Unpacking LZ4', 'lz4-verify': 'Verifying',
  'compress': 'Compressing', 'make-image': 'Making image', 'uncompress': 'Uncompressing',
  'validate-repair': 'Validating', 'validate-only': 'Validating', 'build-ampr-index': 'Building AMPR index',
  'set-read-only': 'Setting read-only', 'extract-image': 'Extracting', 'refresh-mount': 'Mounting',
  'read-speed-test': 'Testing read speed', 'update-ampr': 'Updating APR-EMU',
  'restore-ampr-original': 'Restoring APR-EMU', 'delete-game-data': 'Deleting',
  'move-to-usb': 'Moving', 'move-to-internal': 'Moving', 'copy-to-usb': 'Copying', 'copy-to-internal': 'Copying',
};

export function opLabel(op) {
  return PHASE_LABEL[String((op && op.action) || '')] || 'Working';
}

function jobSpeed(job) {
  for (const key of ['speedBytesPerSec', 'speedBytesPerSecond', 'averageSpeedBytesPerSec',
    'compressBytesPerSecond', 'bytesPerSecond']) {
    const value = Number(job[key] || 0);
    if (value > 0) return value;
  }
  return 0;
}

// Progress of the running job for its game: {label, percent|null, detail}.
export function progressFor(game, job) {
  const op = game && game.activeOp;
  if (!op) return null;
  const active = job && String(job.activeId || '') === String(op.id || '') ? job : null;
  const total = active ? Number(active.totalBytes || 0) : 0;
  const done = active ? Number(active.copiedBytes || 0) : 0;
  const percent = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : null;
  const speed = active ? jobSpeed(active) : 0;
  const parts = [];
  if (total > 0) parts.push(`${formatBytes(done)} of ${formatBytes(total)}`);
  if (speed > 0) parts.push(`${formatBytes(speed)}/s`);
  if (speed > 0 && total > done) parts.push(`${formatDuration((total - done) / speed)} left`);
  return {
    label: active && active.cancelRequested ? 'Cancelling' : opLabel(op),
    percent,
    detail: parts.join('  ·  '),
    current: active ? String(active.current || '') : '',
    cancelDisabled: !!(active && active.cancelDisabled),
  };
}

export function statusOf(game) {
  if (!game) return {text: '', tone: 'muted'};
  if (game.activeOp) return {text: opLabel(game.activeOp), tone: 'accent'};
  if (game.pendingOp) return {text: 'Queued', tone: 'warn'};
  if (onDemand(game)) return {text: 'Mounts when played', tone: 'muted'};
  if (game.isMounted === false) return {text: 'Not mounted', tone: 'bad'};
  const validation = String(game.validation || '').toLowerCase();
  if (validation === 'validated') return {text: 'Validated', tone: 'good'};
  if (validation === 'failed') return {text: 'Validation failed', tone: 'bad'};
  return {text: 'Ready', tone: 'good'};
}

export const TONE_COLOR = {
  good: '#2fd27a', warn: '#f5b942', bad: '#ff5c70', accent: '#12cc62', muted: '#8a958c',
};

const RESULT_TEXT = {
  success: 'Done', clean: 'Clean', deleted: 'Deleted', tested: 'Tested', failed: 'Failed',
  cancelled: 'Cancelled', repaired: 'Repaired', 'not-mounted': 'Done (not mounted)',
};

export function resultText(op) {
  const status = String((op && op.status) || '').toLowerCase();
  if (status === 'running') return 'Running';
  if (status === 'pending') return 'Queued';
  const result = String((op && op.result) || status);
  return RESULT_TEXT[result] || RESULT_TEXT[status] || result || status;
}

export function opTone(op) {
  const status = String((op && op.status) || '').toLowerCase();
  if (status === 'success') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'running') return 'accent';
  if (status === 'pending') return 'warn';
  return 'muted';
}

export function opSummary(op) {
  // The engine runs Verify Game Files as lz4-verify too.
  const parts = [op.action === 'lz4-verify' ? 'Verify' : ACTION_LABEL[op.action] || op.action];
  if (op.savedBytes > 0) parts.push(`saved ${formatBytes(op.savedBytes)}`);
  if (op.compressedSize > 0 && op.compressionSourceSize > 0) {
    parts.push(`${formatBytes(op.compressionSourceSize)} → ${formatBytes(op.compressedSize)}`);
  }
  if (op.badBlocksFound > 0) parts.push(`${op.badBlocksFound} bad blocks`);
  if ((op.action === 'lz4-verify' || op.action === 'lz4-pack') && op.repairSummary) parts.push(op.repairSummary);
  return parts.join('  ·  ');
}

export function opTime(op) {
  return Number(op.endedAt || op.startedAt || op.createdAt || 0);
}

// Keep the previous object for games whose data did not change, so the
// library's memoized tiles don't redraw on every refresh.
export function stabilize(previous, next) {
  const byId = new Map((previous || []).map(game => [game.instanceId || game.titleId + game.sourcePath, game]));
  return next.map(game => {
    const key = game.instanceId || game.titleId + game.sourcePath;
    const old = byId.get(key);
    return old && JSON.stringify(old) === JSON.stringify(game) ? old : game;
  });
}

export const gameId = game => game.instanceId || `${game.titleId}:${game.sourcePath}`;
