// Centralised filesystem layout for the manager.
//
// The app has two distinct "data" homes:
//
//   1. INTERNAL data dir (DATA_DIR, default /app/data)
//      Holds things the user never touches directly - SQLite database,
//      queue-state snapshots, IPC sockets, etc. Lives inside the
//      container's bind-mounted ./data volume.
//
//   2. USER data dir (USER_DATA_DIR, default /data)
//      Holds the three user-visible working folders:
//        - payloads/   uploaded .lua/.elf/.bin (and downloads via Add)
//        - mkpfs/      mkpfs work dir (staging, output .ffpfsc, scratch)
//        - downloads/  default download destination
//      Lives on the host's /data mount so the user can browse it via
//      the file browser, scp into it, etc. The three sub-folders are
//      surfaced as the top entries in /local/roots.
//
// Both roots are env-overridable for unit-test isolation and for
// non-Docker deployments. The migration step in startup.js handles
// in-place upgrades from the legacy layout where payloads/ and mkpfs/
// lived under /app/data.

import path from 'path';

export const internalDataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), 'data');

export const userDataDir = process.env.USER_DATA_DIR
  ? path.resolve(process.env.USER_DATA_DIR)
  : '/data';

export const payloadsDir = path.join(userDataDir, 'payloads');
export const mkpfsWorkDir = path.join(userDataDir, 'mkpfs');
export const downloadsDir = path.join(userDataDir, 'downloads');

// Subset of /local/roots that the file-browser quick-tabs surface
// FIRST (in this exact order). The rest of the host roots (/mnt,
// /home, /data, /tmp, /media) come after these, deduped.
export const USER_QUICK_TABS = [payloadsDir, mkpfsWorkDir, downloadsDir];
