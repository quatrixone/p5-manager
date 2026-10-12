import test from 'node:test';
import assert from 'node:assert/strict';
import { actionFor, installedBadge, needsConsole, unverifiedWarning } from './marketplaceView.js';

const script = { kind: 'script', id: 'home', name: 'Home', version: 2 };
const homebrewPkg = { kind: 'homebrew', id: 'cheats', name: 'Cheats', version: 1, files: ['pkg'], console_type: 'ps4' };
const catalogPkg = { kind: 'catalog', id: 'c1', name: 'Pack', installable: true, verified: false, package_url: 'https://e.org/a.pkg' };

test('only items that end up on the console need one', () => {
  assert.equal(needsConsole(script), false);
  assert.equal(needsConsole({ kind: 'payload' }), false);
  assert.equal(needsConsole(homebrewPkg), true);
  assert.equal(needsConsole({ kind: 'homebrew', files: ['elf'] }), false);
  assert.equal(needsConsole({ kind: 'template', requiresProfile: false }), false);
  assert.equal(needsConsole({ kind: 'template' }), true);
  assert.equal(needsConsole(catalogPkg), true);
});

test('the button says Install, or Update when a newer version is listed', () => {
  assert.equal(actionFor(script).label, 'Install');
  assert.equal(actionFor({ ...script, installed: 1, update: true }).label, 'Update');
  assert.equal(actionFor({ ...script, installed: 2 }).label, 'Install again');
  assert.equal(actionFor({ ...homebrewPkg, onConsole: true }, { consoleOnline: true }).label, 'Install again');
});

test('an item that needs a console says why it cannot be installed now', () => {
  assert.deepEqual(actionFor(script, { consoleOnline: false }), { action: 'install', label: 'Install', disabled: false, reason: '' });
  const off = actionFor(homebrewPkg, { consoleOnline: false });
  assert.equal(off.disabled, true);
  assert.match(off.reason, /not on/);
  assert.equal(actionFor(homebrewPkg, { consoleOnline: true }).disabled, false);
  // Unknown state never blocks: the install itself will report the truth.
  assert.equal(actionFor(homebrewPkg, { consoleOnline: null }).disabled, false);
  const noProfile = actionFor(homebrewPkg, { consoleOnline: true, hasProfile: false });
  assert.equal(noProfile.disabled, true);
  assert.match(noProfile.reason, /PS4 profile/);
});

test('a catalog listing without a usable package stays a link', () => {
  const linkOnly = actionFor({ kind: 'catalog', installable: false, package_url: 'https://e.org/a.zip' });
  assert.equal(linkOnly.action, 'link');
  assert.equal(linkOnly.disabled, false);
  assert.equal(actionFor({ kind: 'catalog', installable: false, package_url: null }).disabled, true);
  assert.equal(actionFor(catalogPkg, { consoleOnline: true }).action, 'install-catalog');
});

test('the badge names where "installed" is known from', () => {
  assert.equal(installedBadge(script), null);
  assert.equal(installedBadge({ ...script, installed: 1, update: true }).text, 'Update v2');
  assert.equal(installedBadge({ ...script, installed: 2 }).text, '✓ Installed');
  const seen = installedBadge({ ...homebrewPkg, onConsole: true, libraryTakenAt: '2026-10-12T07:00:00.000Z' });
  assert.equal(seen.text, '✓ On console');
  assert.match(seen.title, /console library on /);
});

test('a package with no checksum says so before it is installed', () => {
  assert.match(unverifiedWarning(catalogPkg), /SHA-256/);
  assert.equal(unverifiedWarning({ ...catalogPkg, verified: true }), '');
  assert.equal(unverifiedWarning(script), '');
});

test('an item already in Payloads, Scripts or Autoload reads as installed', () => {
  const payload = { kind: 'payload', id: 'kstuff', name: 'kstuff.elf', version: 1, inLibrary: true, localVersion: 'v1.09' };
  assert.equal(installedBadge(payload).text, '✓ Installed');
  assert.match(installedBadge(payload).title, /payload library \(v1.09\)/);
  assert.equal(actionFor(payload).label, 'Install again');
  const script = { kind: 'script', id: 'home', name: 'Home', version: 1, inLibrary: true };
  assert.match(installedBadge(script).title, /My Scripts/);
  const newer = { ...payload, update: true, app_version: '1.11' };
  assert.equal(installedBadge(newer).text, 'Update v1.11');
  assert.match(installedBadge(newer).title, /You have v1.09/);
  assert.equal(actionFor(newer).label, 'Update');
});
