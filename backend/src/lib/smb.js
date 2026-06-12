import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getRepo } from '../db/sqlite.js';

export function buildSmbArgs(src) {
  const target = `//${src.smb_host}/${src.smb_share}`;
  const args = [target];
  if (src.smb_password) args.push(src.smb_password);
  if (src.smb_username) args.push('-U', src.smb_domain ? `${src.smb_domain}\\${src.smb_username}` : src.smb_username);
  else args.push('-N');
  return args;
}

export function runSmbClient(args, input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('smbclient', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

export function smbClientError(out, code) {
  const m = out.match(/(NT_STATUS_(?!OK\b)[A-Z_]+)/);
  if (m) {
    const status = m[1];
    const msg = status === 'NT_STATUS_OBJECT_NAME_NOT_FOUND' ? 'Path not found'
      : status === 'NT_STATUS_ACCESS_DENIED' ? 'Access denied'
      : status === 'NT_STATUS_LOGON_FAILURE' ? 'Authentication failed (check username/password)'
      : status === 'NT_STATUS_BAD_NETWORK_NAME' ? 'Share not found'
      : status === 'NT_STATUS_HOST_UNREACHABLE' || status === 'NT_STATUS_CONNECTION_REFUSED' ? 'Host unreachable'
      : status === 'NT_STATUS_NO_SUCH_FILE' ? 'No matching files'
      : status;
    return { status, message: msg };
  }
  if (code !== 0) return { status: 'EXIT', message: out.trim().split('\n').slice(-3).join(' ') || `smbclient exit ${code}` };
  return null;
}

export function getSmbSource(id) {
  return getRepo().queryOne('SELECT * FROM convert_sources WHERE id = ? AND type = ?', [id, 'smb']);
}

export function listSmbSources() {
  return getRepo().queryAll(
    "SELECT id, name, type, path, smb_host, smb_share, smb_username, smb_domain, enabled FROM convert_sources WHERE type = 'smb' ORDER BY name",
  );
}

export function uploadDirToSmb(src, localDir, smbDir, logFn = () => {}) {
  return new Promise((resolve) => {
    const cleanRemote = (smbDir || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const lines = [];
    if (cleanRemote) lines.push(`cd "${cleanRemote}"`);

    const walk = (rel) => {
      const abs = rel ? path.join(localDir, rel) : localDir;
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const sub = (rel ? `${rel}/${e.name}` : e.name).replace(/\\/g, '/');
        const subAbs = path.join(abs, e.name);
        if (e.isDirectory()) {
          lines.push(`mkdir "${sub}"`);
          walk(sub);
        } else if (e.isFile()) {
          lines.push(`put "${subAbs}" "${sub}"`);
        }
      }
    };
    walk('');

    const numFiles = lines.filter(l => l.startsWith('put ')).length;
    const numDirs = lines.filter(l => l.startsWith('mkdir ')).length;
    if (numFiles === 0) {
      logFn('[smb] nothing to upload\n');
      return resolve({ code: 0 });
    }

    const args = buildSmbArgs(src);
    logFn(`[smb] $ smbclient ${args.filter(a => a !== src.smb_password).join(' ')}\n`);
    logFn(`[smb] target dir: ${cleanRemote || '/'} (${numFiles} files, ${numDirs} dirs)\n`);

    const proc = spawn('smbclient', args);
    let stderrBuf = '';
    proc.stdout.on('data', d => logFn(d.toString()));
    proc.stderr.on('data', d => { stderrBuf += d.toString(); logFn(d.toString()); });
    proc.on('error', err => resolve({ code: -1, error: err.message }));
    proc.on('close', code => {
      if (code !== 0) {
        const errInfo = smbClientError(stderrBuf, code);
        return resolve({ code, error: errInfo ? errInfo.message : `smbclient exit ${code}` });
      }
      resolve({ code: 0 });
    });

    proc.stdin.write(lines.join('\n') + '\nquit\n');
    proc.stdin.end();
  });
}
