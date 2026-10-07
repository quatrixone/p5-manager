// The one place a console's FTP port comes from. Each profile has its own
// (Settings -> Profiles -> Edit -> "FTP port"); when that is left empty the
// port follows the console type. File Ops, uploads, downloads to the
// console, the install queue and offline activation all ask here, by the
// console's IP address.
import { getRepo } from '../db/sqlite.js';

// What the usual FTP server of each console listens on: zftpd on a PS5,
// the GoldHEN-era FTP payloads on a PS4.
export const DEFAULT_FTP_PORTS = { ps5: 2120, ps4: 2121 };

const valid = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
};

// Port for a profile row ({ ftp_port, console_type }) or for no profile.
export function ftpPortOf(profile) {
  const own = valid(profile?.ftp_port);
  if (own) return own;
  if (profile?.console_type === 'ps4') return DEFAULT_FTP_PORTS.ps4;
  // Before ports were per console there was one for everything, saved in
  // settings. A value set there still counts for consoles without their own.
  try {
    const repo = getRepo();
    const legacy = valid(repo.queryScalar("SELECT value FROM settings WHERE key = 'ftp_control_port'"));
    if (legacy) return legacy;
    const older = repo.queryScalar("SELECT value FROM settings WHERE key = 'ftp_login'");
    return valid(older && JSON.parse(older).port) || DEFAULT_FTP_PORTS.ps5;
  } catch (_) {
    return DEFAULT_FTP_PORTS.ps5;
  }
}

export function getFtpPort(ip) {
  let profile = null;
  try {
    if (ip) profile = getRepo().queryOne('SELECT ftp_port, console_type FROM profiles WHERE TRIM(ip_address) = ? LIMIT 1', [String(ip).trim()]);
  } catch (_) {}
  return ftpPortOf(profile);
}
