import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const safeName = name => typeof name === 'string' && name !== '.' && name !== '..' && name.length > 0 && !/[\\/\x00-\x1f]/.test(name);

export function consoleArchiveLocation(ip, remotePath) {
  if (!net.isIP(ip || '')) throw new Error('A console IP address is required');
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/') || /[\\\x00-\x1f]/.test(remotePath) || remotePath.split('/').includes('..')) {
    throw new Error('Invalid console archive path');
  }
  const name = path.posix.basename(remotePath);
  const stem = name.replace(/\.(?:part\d+\.rar|rar|r\d{2}|zip|7z|tar\.gz|tgz|tar)$/i, '');
  if (!safeName(name) || !safeName(stem) || name === stem) throw new Error('Unsupported archive name');
  const dir = path.posix.dirname(remotePath);
  return { ip, path: remotePath, name, dir, dest: path.posix.join(dir, stem) };
}

export async function downloadConsoleArchive(client, location, localDir, checkCancelled) {
  checkCancelled();
  const entries = await client.list(location.dir);
  const escaped = location.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /\.part\d+\.rar$/i.test(location.name)
    ? new RegExp('^' + escaped.replace(/part\d+\\\.rar$/i, 'part\\d+\\.rar') + '$', 'i')
    : /\.(rar|r\d{2})$/i.test(location.name)
      ? new RegExp('^' + escaped.replace(/\\\.(rar|r\d{2})$/i, '\\.(rar|r\\d{2,3})') + '$', 'i')
      : null;
  const names = pattern
    ? entries.filter(e => !e.isDirectory && e.type !== 2 && pattern.test(e.name)).map(e => e.name)
    : [location.name];
  if (!names.includes(location.name)) throw new Error('Archive not found on console');
  for (const name of names) {
    if (!safeName(name)) throw new Error('Invalid archive volume name');
    checkCancelled();
    await client.downloadTo(path.join(localDir, name), path.posix.join(location.dir, name));
  }
  checkCancelled();
  return path.join(localDir, location.name);
}

export async function uploadConsoleArchive(client, location, localDir, checkCancelled) {
  // Never follow archive links when copying files back to the console.
  const verify = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      checkCancelled();
      if (!safeName(entry.name) || (!entry.isDirectory() && !entry.isFile())) throw new Error('Archive contains an unsupported file or symbolic link');
      if (entry.isDirectory()) verify(path.join(dir, entry.name));
    }
  };
  verify(localDir);
  checkCancelled();
  const entries = await client.list(location.dir);
  if (entries.some(e => e.name.toLowerCase() === path.posix.basename(location.dest).toLowerCase())) {
    throw new Error(`Destination already exists: ${location.dest}. Rename or move it before retrying.`);
  }
  await client.uploadFromDir(localDir, location.dest);
  checkCancelled();
}
