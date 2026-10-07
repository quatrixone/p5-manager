import fs from 'fs';
import os from 'os';
import path from 'path';

// Everything that differs between the Docker/Linux deployment and the
// portable Windows build lives here, so route code asks questions
// ("is this a filesystem root?", "where do local browsers start?") instead
// of sprinkling process.platform checks around. The pure helpers take the
// platform as a parameter so the Windows behaviour is tested on Linux.

export const isWindows = process.platform === 'win32';

// Paths handed to the browser always use forward slashes: the UI builds and
// splits paths with '/', and Node accepts 'C:/Users/x' on Windows.
export function toClientPath(p, win = isWindows) {
  return win ? String(p).replace(/\\/g, '/') : p;
}

// The UI ships with POSIX defaults ('/mnt', '/data/downloads', ...). On
// Windows those are not real places: '/data/...' maps into the app's data
// folder (that is what it means in Docker too) and anything else to the
// user's home, so every picker opens somewhere sensible.
export function mapPosixDefault(reqPath, { win = isWindows, userDataDir, home = os.homedir() } = {}) {
  if (!win) return reqPath;
  const s = String(reqPath || '').replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s) || s.startsWith('//')) return reqPath; // drive path or UNC share
  if (userDataDir && (s === '/data' || s.startsWith('/data/'))) return userDataDir + s.slice('/data'.length);
  return home;
}

// 'C:\' and '/' have no parent to go up to.
export function isFsRoot(absPath, pathMod = path) {
  return pathMod.parse(absPath).root === absPath;
}

// Entry points for the local file browser's quick tabs.
export function listLocalRoots(posixCandidates) {
  const exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  if (!isWindows) return posixCandidates.filter(exists);
  const drives = [];
  for (let c = 67; c <= 90; c++) { // C: .. Z: (A:/B: are floppy letters and can block)
    const d = `${String.fromCharCode(c)}:\\`;
    if (exists(d)) drives.push(d);
  }
  return [os.homedir(), ...drives];
}

// Folders the local browser must not read or write. Linux: system trees.
// Windows: the Windows directory itself.
const POSIX_BLOCKED = [
  '/etc', '/root', '/sys', '/proc', '/boot', '/usr', '/bin', '/sbin',
  '/lib', '/lib32', '/lib64', '/dev', '/run', '/var/run', '/var/cache',
  '/var/lib/docker', '/var/lib/containers', '/var/lib/snapd', '/snap',
];
export function isLocalPathAllowed(absPath, { win = isWindows, pathMod = path, systemRoot = process.env.SystemRoot } = {}) {
  const norm = pathMod.resolve(absPath);
  const blocked = win ? (systemRoot ? [pathMod.resolve(systemRoot)] : []) : POSIX_BLOCKED;
  const fold = (s) => (win ? s.toLowerCase() : s);
  for (const prefix of blocked) {
    if (fold(norm) === fold(prefix) || fold(norm).startsWith(fold(prefix) + pathMod.sep)) return false;
  }
  return true;
}

// Where convert and extract jobs may read and write. On Linux that is a list
// of roots: the working folders plus the trees disks are mounted in. Windows
// has no such tree - a disk is a drive letter, and the local browser offers
// every one of them - so there any place the browser may use counts.
export function isInsideRoots(absPath, roots, { win = isWindows, pathMod = path, systemRoot = process.env.SystemRoot } = {}) {
  const real = pathMod.resolve(absPath);
  if (win) return isLocalPathAllowed(real, { win, pathMod, systemRoot });
  return roots.some((r) => {
    const root = pathMod.resolve(r);
    return real === root || real.startsWith(root.endsWith(pathMod.sep) ? root : root + pathMod.sep);
  });
}

// What this build can do; the UI hides or explains the rest.
export function platformInfo() {
  return {
    os: process.platform,
    portable: !!process.env.P5M_PORTABLE,
    features: {
      // losetup / mount / mkfs.exfat - Linux only.
      exfat: !isWindows,
      // SMB sources go through smbclient; on Windows use a \\server\share path.
      smb_sources: !isWindows,
    },
  };
}
