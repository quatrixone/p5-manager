// The one place the console's FTP port comes from: Settings -> Config ->
// "Console FTP port" (settings key `ftp_control_port`). File Ops, uploads,
// downloads to the console, the install queue and offline activation all
// read it through here, so changing it in Settings changes it everywhere.
import { getRepo } from '../db/sqlite.js';

// zftpd's default, the FTP server the app ships and starts by itself.
export const DEFAULT_FTP_PORT = 2120;

const valid = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
};

export function getFtpPort() {
  try {
    const repo = getRepo();
    const set = valid(repo.queryScalar("SELECT value FROM settings WHERE key = 'ftp_control_port'"));
    if (set) return set;
    // Older installs kept a second copy of the port inside `micromount_ftp`.
    const legacy = repo.queryScalar("SELECT value FROM settings WHERE key = 'micromount_ftp'");
    return valid(legacy && JSON.parse(legacy).port) || DEFAULT_FTP_PORT;
  } catch (_) {
    return DEFAULT_FTP_PORT;
  }
}
