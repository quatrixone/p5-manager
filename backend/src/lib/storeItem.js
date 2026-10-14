// What the marketplace (store/ in the repository) holds, and the checks an
// item has to pass - here, before the app installs it, and in CI, before
// it is listed (scripts/build-store-index.mjs).
//
// An item is one JSON file:
//   store/templates/<id>.json  { kind: "template", id, name, description,
//       author, version, console_type?, requiresProfile?, autoTrigger?, steps }
//   store/scripts/<id>.json    { kind: "script", id, name, description,
//       author, version, console_type?, script }
//   store/homebrew/<id>.json   { kind: "homebrew", id, name, description,
//       author, version, console_type, app_version?, homepage?, license?,
//       files: [{ type: "pkg" | "elf" | "bin" | "lua", url, sha256, size? }] }
// A homebrew item only points at the files on their author's own release
// page; nothing is stored here. They are pinned by SHA-256 and size, which
// the submission workflow fills in when it accepts the item (a submission
// may leave them out), and the app checks every download against them.
// `version` is a whole number that goes up with each change; the app offers
// an update when the listed one is higher than the installed one.

import { validateSequenceSteps } from './sequenceChecks.js';

export const STORE_REPO = 'quatrixone/p5-marketplace';
export const STORE_BRANCH = 'main';

export const STEP_TYPES = new Set([
  'wait', 'wol', 'check_port', 'payload', 'download', 'extract', 'ftp_upload',
  'convert', 'input_script', 'rp_session',
]);
const KINDS = { template: 'templates', script: 'scripts', homebrew: 'homebrew', payload: 'payloads' };
export const HOMEBREW_FILE_TYPES = new Set(['pkg', 'elf', 'bin', 'lua', 'zip', 'ffpfsc']);
// What the app has somewhere to put: a package goes to the console or the
// install queue, the rest into the payload library. PS5 native archives are
// listed and described, but nothing here installs them yet.
export const INSTALLABLE_FILE_TYPES = new Set(['pkg', 'elf', 'bin', 'lua']);
const MAX_STEPS = 100;
const MAX_SCRIPT_CHARS = 20_000;

export const storeDir = (kind) => Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;

function text(v, max, what, errors, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) errors.push(`${what} is missing`);
    return;
  }
  if (typeof v !== 'string') errors.push(`${what} has to be text`);
  else if (v.length > max) errors.push(`${what} is longer than ${max} characters`);
}

// The problems with an item, or [] when there are none.
export function validateStoreItem(item, { submission = false } = {}) {
  const errors = [];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ['the item has to be a JSON object'];
  if (!Object.hasOwn(KINDS, item.kind)) errors.push('kind has to be "template", "script" "homebrew" or "payload"');
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(item.id)) {
    errors.push('id has to be 3 to 64 lowercase letters, digits and dashes');
  }
  text(item.name, 80, 'name', errors);
  text(item.description, 500, 'description', errors);
  text(item.author, 40, 'author', errors);
  if (item.github_owner_id !== undefined && (!Number.isSafeInteger(item.github_owner_id) || item.github_owner_id < 1)) errors.push('github_owner_id has to be a positive GitHub user id');
  if (item.icon !== undefined && (typeof item.icon !== 'string' || !/^https:\/\/\S{4,500}$/.test(item.icon))) errors.push('icon has to be an https:// address');
  if (item.homebrew_id !== undefined && (typeof item.homebrew_id !== 'string' || !/^[A-Z0-9]{9}$/.test(item.homebrew_id))) errors.push('homebrew_id must be a nine-character Homebrew Store title id');
  if (item.builtin_id !== undefined && (typeof item.builtin_id !== 'string' || !((item.kind === 'script' && /^builtin:[a-z0-9-]+$/.test(item.builtin_id)) || (item.kind === 'template' && /^tpl-[a-z0-9-]+$/.test(item.builtin_id))))) errors.push('builtin_id is only valid for curated scripts and templates');

  if (!Number.isInteger(item.version) || item.version < 1) errors.push('version has to be a whole number from 1');
  if (item.console_type !== undefined && !['ps4', 'ps5'].includes(item.console_type)) {
    errors.push('console_type has to be "ps4" or "ps5" (or left out for both)');
  }
  if (item.kind === 'template') {
    if (!Array.isArray(item.steps) || item.steps.length === 0) errors.push('steps has to be a list with at least one step');
    else if (item.steps.length > MAX_STEPS) errors.push(`more than ${MAX_STEPS} steps`);
    else {
      item.steps.forEach((s, i) => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) errors.push(`step ${i + 1} has to be an object`);
        else if (!STEP_TYPES.has(s.type)) errors.push(`step ${i + 1}: unknown type "${s.type}"`);
      });
    }
    if (Array.isArray(item.steps) && item.steps.length) { try { validateSequenceSteps(item.steps); } catch (e) { errors.push(e.message); } }
    if (item.autoTrigger !== undefined && item.autoTrigger !== 'loader_down') errors.push('autoTrigger can only be "loader_down"');
    if (item.requiresProfile !== undefined && typeof item.requiresProfile !== 'boolean') errors.push('requiresProfile has to be true or false');
  }
  if (item.kind === 'script') {
    if (typeof item.script !== 'string' || !item.script.trim()) errors.push('script is missing');
    else if (item.script.length > MAX_SCRIPT_CHARS) errors.push(`script is longer than ${MAX_SCRIPT_CHARS} characters`);
  }
  if (item.kind === 'homebrew' || item.kind === 'payload') {
    if (!['ps4', 'ps5'].includes(item.console_type)) errors.push('console_type has to be "ps4" or "ps5"');
    text(item.app_version, 20, 'app_version', errors, { required: false });
    text(item.license, 40, 'license', errors, { required: false });
    if (item.title_id !== undefined && !/^PPSA\d{5}$/.test(item.title_id)) errors.push('title_id must be a PS5 PPSA title ID');
    if (item.comingSoon === true && item.kind === 'homebrew') {
      if (!Array.isArray(item.files) || item.files.length) errors.push('coming-soon entries cannot contain downloadable files');
      return errors;
    }
    if (item.homepage !== undefined && !/^https:\/\/\S{4,300}$/.test(item.homepage)) errors.push('homepage has to be an https:// address');
    if (!Array.isArray(item.files) || item.files.length === 0 || item.files.length > 5) errors.push('files has to list 1 to 5 files');
    else {
      item.files.forEach((f, i) => {
        const n = `file ${i + 1}`;
        if (!f || typeof f !== 'object') { errors.push(`${n} has to be an object`); return; }
        if (item.kind === 'payload' && f.type === 'pkg') errors.push(`${n}: payloads cannot contain pkg files`);
        if (!HOMEBREW_FILE_TYPES.has(f.type)) errors.push(`${n}: unsupported file type`);
        if (['zip', 'ffpfsc'].includes(f.type) && (item.console_type !== 'ps5' || !/^PPSA\d{5}$/.test(item.title_id || ''))) errors.push(`${n}: native archives require PS5 and title_id`);
        if (typeof f.url !== 'string' || !/^https:\/\/\S{4,500}$/.test(f.url)) errors.push(`${n}: url has to be an https:// address`);
        if (!(submission && f.sha256 === undefined) && (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256))) {
          errors.push(`${n}: sha256 has to be 64 lowercase hex digits`);
        }
        if (f.size !== undefined && !(Number.isInteger(f.size) && f.size > 0)) errors.push(`${n}: size has to be a positive whole number`);
        const name = homebrewFileName(f);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(pkg|elf|bin|lua|zip|ffpfsc)$/i.test(name)) errors.push(`${n}: the file name (from the url, or "name") is not usable`);
        if (!name.toLowerCase().endsWith(`.${f.type}`)) errors.push(`${n}: filename extension must match file type`);
      });
    }
  }
  return errors;
}

// The name a homebrew file is stored under: `name`, or the url's last part.
export function homebrewFileName(f) {
  if (f?.name) return String(f.name);
  try { return decodeURIComponent(new URL(f.url).pathname.split('/').pop() || ''); } catch (_) { return ''; }
}

// The fields an item is listed with in store/index.json.
export function indexEntry(item, path) {
  return {
    kind: item.kind,
    id: item.id,
    name: item.name,
    description: item.description,
    author: item.author,
    version: item.version,
    ...(item.github_owner_id ? { github_owner_id: item.github_owner_id } : {}),
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.homebrew_id ? { homebrew_id: item.homebrew_id } : {}),
    ...(item.builtin_id ? { builtin_id: item.builtin_id } : {}),
    ...(item.console_type ? { console_type: item.console_type } : {}),
    ...(item.kind === 'template' ? { steps: item.steps.length, requiresProfile: item.requiresProfile !== false, ...(item.autoTrigger ? { autoTrigger: item.autoTrigger } : {}) } : {}),
    ...(item.kind === 'script' ? { lines: item.script.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length } : {}),
    ...(['homebrew', 'payload'].includes(item.kind) ? {
      files: item.files.map((f) => f.type),
      ...(item.app_version ? { app_version: item.app_version } : {}),
      // A single-file payload is listed with its checksum, so the app can
      // recognise the very same file already in the library, whatever the
      // user called it.
      ...(item.files.length === 1 && item.files[0].sha256 ? { sha256: item.files[0].sha256 } : {}),
      ...(item.files.every((f) => f.size) ? { size: item.files.reduce((a, f) => a + f.size, 0) } : {}),
      ...(item.homepage ? { homepage: item.homepage } : {}),
    } : {}),
    path,
  };
}

// An item made from something of the user's, for publishing.
export function itemFromScript({ name, script }, { id, description, author, console_type }) {
  return { kind: 'script', id, name, description, author, version: 1, ...(console_type ? { console_type } : {}), script };
}

export function itemFromSequence({ name, steps, auto_trigger }, { id, description, author, console_type }) {
  return {
    kind: 'template', id, name, description, author, version: 1,
    ...(console_type ? { console_type } : {}),
    requiresProfile: true,
    ...(auto_trigger === 'loader_down' ? { autoTrigger: 'loader_down' } : {}),
    steps,
  };
}

export function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'item';
}

// The files of an item the app cannot install anywhere, by their name. An
// empty list means every file has a destination.
export function uninstallableFiles(item) {
  return (item?.files || []).filter((f) => !INSTALLABLE_FILE_TYPES.has(f?.type)).map((f) => homebrewFileName(f));
}
