// PS5-friendly exFAT image builder.
//
// ShadowMount+ / MicroMount on PS5 can mount a raw `.exfat` image straight
// off external storage — no UFS / PFS wrapper needed. The original Windows
// pipeline (kerrdec97/ps5-exfat-builder) does this by:
//
//   1. Allocating a raw image file at size = source + headroom
//   2. Formatting it with mkfs.exfat
//   3. Mounting the image via OSFMount and robocopy'ing the dump in
//   4. Dismounting and shipping the file off to the PS5
//
// We do exactly the same on Linux. Steps 1-2 and 4 are plain userspace.
// Step 3 is the awkward one — `mount(2)` and `losetup` both need
// CAP_SYS_ADMIN, which we add to the `app` container in docker-compose.yml.
// Without that cap the build fails fast with a clear "mount: permission
// denied" line in the job log instead of corrupting the image.
//
// The unpack path is symmetric: loop-mount the image read-only, recursively
// copy out to the destination directory, unmount.
//
// All helpers below take a `job` object that already has `.log` /
// `.progress` / `.phase` fields plus an `appendLog(job, chunk)` and
// `updateProgressFromText(job, text)` injected from convert.js so progress
// surfaces through the existing queue UI without a second polling pipeline.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';

// Pick the loop-mount temp staging root. We deliberately use the OS tmpdir
// so loop mounts don't bind into one of the Docker bind volumes (which would
// confuse the file browser + slow down recursive copies). /tmp inside the
// container is tmpfs in most setups and big enough for the mountpoint itself
// — actual file payload still lives on the source / target disk via the
// image file we mount on top.
const MOUNT_ROOT = path.join(os.tmpdir(), 'p5-exfat-mounts');

// Wrap losetup / mount / umount / mkfs.exfat through sudo so the running
// process (uid 1000) actually becomes root for the syscalls that need
// CAP_SYS_ADMIN. The sudoers entry baked into the Dockerfile pins the
// allowlist to exactly these four binaries (+ sync) with NOPASSWD, so this
// is bounded — we can't escalate to "anything goes". Tools that don't need
// privileges (truncate, rsync) stay un-wrapped so they keep writing as
// uid 1000 for clean ownership.
const SUDO = 'sudo';
const SUDO_PREFIX = ['-n']; // -n = non-interactive; bail if a password were ever required

// MiB unit. We round all sizes up to whole MiB so mkfs.exfat is happy and
// the resulting image can be split / hashed cleanly.
const MIB = 1024 * 1024;

// Default headroom = max(10% of payload, 64 MiB) up to a 1 GiB ceiling.
// exFAT FAT + bitmap overhead is tiny (~0.1%) so the headroom mostly
// absorbs cluster-size rounding and "what if the user adds a few files via
// FileBrowser later" cases. 64 MiB minimum keeps tiny payloads from
// ending up in a too-small container.
function calcHeadroomBytes(payloadBytes) {
  const tenPct = Math.ceil(payloadBytes * 0.10);
  const floor = 64 * MIB;
  const ceiling = 1024 * MIB;
  return Math.min(ceiling, Math.max(floor, tenPct));
}

// Recursively sum the size of a path (file or directory). Mirrors
// pathSizeBytes in convert.js but lives here so the helper module is
// self-contained.
export function pathSizeBytes(p) {
  if (!p) return 0;
  let st;
  try { st = fs.statSync(p); } catch (_) { return 0; }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur); } catch (_) { continue; }
    for (const name of entries) {
      const full = path.join(cur, name);
      let s;
      try { s = fs.statSync(full); } catch (_) { continue; }
      if (s.isDirectory()) stack.push(full);
      else total += s.size;
    }
  }
  return total;
}

// ─── Small shell helpers ──────────────────────────────────────────────────

// Stream stdout/stderr from a child process into job.log via the caller-
// supplied appendLog. Resolves to {code, error?} on close — never rejects.
function spawnLogged(job, helpers, cmd, args, opts = {}) {
  const { appendLog } = helpers;
  return new Promise((resolve) => {
    appendLog(job, `[manager] $ ${cmd} ${args.join(' ')}\n`);
    let proc;
    try {
      proc = spawn(cmd, args, opts);
    } catch (e) {
      appendLog(job, `[manager] spawn failed: ${e.message}\n`);
      return resolve({ code: -1, error: e.message });
    }
    job._proc = proc;
    job.pid = proc.pid;
    proc.stdout.on('data', d => {
      appendLog(job, d);
      // Progress hint: cp from coreutils emits a single % line per file when
      // run with `--info=progress2` (rsync) but plain cp is silent. We rely
      // on the rsync path below for live %; nothing to do here.
    });
    proc.stderr.on('data', d => appendLog(job, d));
    proc.on('error', err => {
      appendLog(job, `[manager] error: ${err.message}\n`);
      resolve({ code: -1, error: err.message });
    });
    proc.on('close', code => resolve({ code }));
  });
}

// Synchronous helper for short commands where we want the captured output
// inline (losetup -j / -f, mountpoint, etc.). Returns {code, stdout, stderr}.
function runSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? r.error.message : null,
  };
}

// Wrap a privileged invocation with sudo. Used for any binary that touches
// /dev/loopN or calls mount(2) — i.e. losetup, mount, umount, mkfs.exfat.
// We never wrap rsync / truncate / sync (sync doesn't need root for fsync
// on a regular fd; we still flush via sync-fs through mount instead).
function sudoArgs(cmd, args) {
  return [...SUDO_PREFIX, cmd, ...args];
}

// ─── Image build (file or folder → .exfat) ────────────────────────────────

/**
 * Build a PS5-friendly exFAT image from a single file OR a directory.
 *
 * Algorithm:
 *   1. Compute payload size + headroom → image size (rounded up to MiB).
 *   2. Truncate the output path to that size (sparse; no zero-fill, fast).
 *   3. mkfs.exfat the image file in-place. mkfs.exfat works directly on a
 *      regular file (it doesn't insist on a block device).
 *   4. losetup -fP --show → /dev/loopN — claims a free loop device backed
 *      by our image.
 *   5. mkdir a unique mountpoint under /tmp/p5-exfat-mounts and `mount -t
 *      exfat -o uid=,gid=` the loop device there.
 *   6. rsync -a --info=progress2 source → mountpoint. rsync emits a single
 *      summary % line we can feed straight into updateProgressFromText.
 *   7. sync, umount, losetup -d, rmdir.
 *
 * On any failure we still try to unmount / detach so loop devices don't
 * leak. We never delete the source. If the *output* image is half-built we
 * leave it on disk so the user can inspect it; the queue marks the job
 * failed with the exit code of the first failing step.
 *
 * @param {object}   job       convert.js job record (mutable; .progress, .phase, .log are written)
 * @param {object}   helpers   { appendLog, updateProgressFromText }
 * @param {string}   src       absolute source path (file or directory)
 * @param {string}   out       absolute destination path for the .exfat image
 * @param {object}   opts
 * @param {string}  [opts.volume_label] exFAT volume label (default = output basename, sans extension)
 * @param {number}  [opts.size_bytes]   manual override for image size (bytes). Without this we auto-size.
 * @returns {Promise<{code:number, error?:string}>}
 */
export async function createExfatImage(job, helpers, src, out, opts = {}) {
  const { appendLog, updateProgressFromText } = helpers;
  if (!fs.existsSync(src)) return { code: -1, error: `source not found: ${src}` };
  const srcStat = fs.statSync(src);

  // 1. Size.
  job.phase = 'sizing';
  const payload = pathSizeBytes(src);
  if (payload <= 0) {
    appendLog(job, `[manager] WARNING: source size is 0; using minimum image size (64 MiB).\n`);
  }
  const headroom = calcHeadroomBytes(payload);
  let totalBytes = payload + headroom;
  if (opts.size_bytes && Number.isFinite(opts.size_bytes) && opts.size_bytes > 0) {
    totalBytes = Math.max(opts.size_bytes, payload + 16 * MIB);
    appendLog(job, `[manager] manual size override: ${(opts.size_bytes / MIB).toFixed(1)} MiB\n`);
  }
  totalBytes = Math.ceil(totalBytes / MIB) * MIB;
  job.bytes_total = payload;
  appendLog(job, `[manager] payload=${(payload / MIB).toFixed(1)} MiB, headroom=${(headroom / MIB).toFixed(1)} MiB, image=${(totalBytes / MIB).toFixed(1)} MiB\n`);

  // 2. Allocate the sparse image file.
  job.phase = 'allocating';
  job.progress = 5;
  try {
    if (fs.existsSync(out)) fs.unlinkSync(out);
    // truncate -s gives us a sparse file — no zero-fill, instant on ext4.
    const r = runSync('truncate', ['-s', String(totalBytes), out]);
    if (r.code !== 0) {
      appendLog(job, `[manager] truncate failed: ${r.stderr || r.stdout || r.error}\n`);
      return { code: r.code ?? -1, error: 'truncate failed' };
    }
    appendLog(job, `[manager] allocated sparse ${path.basename(out)} (${(totalBytes / MIB).toFixed(1)} MiB)\n`);
  } catch (e) {
    appendLog(job, `[manager] allocate error: ${e.message}\n`);
    return { code: -1, error: e.message };
  }

  // 3. Format. mkfs.exfat works directly on a regular file backed by the
  //    `-i` (no block-device check) behaviour of recent exfatprogs.
  job.phase = 'formatting';
  job.progress = 15;
  // exFAT volume label: max 11 UTF-16 codepoints per the spec. mkfs.exfat
  // hard-rejects anything longer with "input string is too long". We strip
  // non-alphanumeric (keeps the bytes-per-codepoint guarantee at 1) and
  // truncate to 11; fall back to PS5DATA if the user's source name was all
  // punctuation.
  const label = (String(opts.volume_label || path.basename(out).replace(/\.exfat$/i, '') || 'PS5DATA')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 11) || 'PS5DATA');
  {
    // -f forces overwrite of any pre-existing FS on the file
    // -L sets the volume label.
    // sudo-wrapped because exfatprogs >= 1.2 requires CAP_SYS_ADMIN to open
    // the image with O_EXCL + low-level ioctls even on a regular file.
    const res = await spawnLogged(job, helpers, SUDO, sudoArgs('mkfs.exfat', ['-f', '-L', label, out]));
    if (res.code !== 0) {
      appendLog(job, `[manager] mkfs.exfat failed (code=${res.code}).\n`);
      return { code: res.code, error: 'mkfs.exfat failed' };
    }
    // mkfs.exfat ran as root; the file may have flipped to root ownership.
    // Hand it back to uid 1000 so subsequent rsync writes inside the loop
    // mount land cleanly and the eventual file on the host bind mount has
    // sane ownership.
    try { fs.chownSync(out, 1000, 1000); } catch (_) { /* best effort */ }
  }

  // 4. Loop attach.
  job.phase = 'attaching';
  job.progress = 25;
  let loopDev = null;
  try {
    const r = runSync(SUDO, sudoArgs('losetup', ['-fP', '--show', out]));
    if (r.code !== 0 || !r.stdout) {
      appendLog(job, `[manager] losetup failed: ${r.stderr || r.stdout || r.error || `code=${r.code}`}\n`);
      appendLog(job, `[manager] HINT: container needs cap_add: [SYS_ADMIN] + /dev/loop-control + sudo allowlist. See docker-compose.yml + Dockerfile.\n`);
      return { code: r.code ?? -1, error: 'losetup failed (need SYS_ADMIN cap)' };
    }
    loopDev = r.stdout.trim().split('\n').pop();
    appendLog(job, `[manager] loop device: ${loopDev}\n`);
  } catch (e) {
    appendLog(job, `[manager] losetup error: ${e.message}\n`);
    return { code: -1, error: e.message };
  }

  // 5. Mount.
  job.phase = 'mounting';
  job.progress = 30;
  let mountDir = null;
  try {
    fs.mkdirSync(MOUNT_ROOT, { recursive: true });
    mountDir = fs.mkdtempSync(path.join(MOUNT_ROOT, 'job-'));
    // uid/gid=1000 so the rsync copy ends up owned by the runtime user
    // (matching the rest of /data). Without this the mount root is
    // root-owned and rsync from a non-root process fails.
    const mountRes = await spawnLogged(job, helpers, SUDO, sudoArgs('mount', ['-t', 'exfat', '-o', 'rw,uid=1000,gid=1000', loopDev, mountDir]));
    if (mountRes.code !== 0) {
      appendLog(job, `[manager] mount failed (code=${mountRes.code}).\n`);
      await cleanupLoop(job, helpers, loopDev, mountDir, false);
      return { code: mountRes.code, error: 'mount failed' };
    }
  } catch (e) {
    appendLog(job, `[manager] mount error: ${e.message}\n`);
    await cleanupLoop(job, helpers, loopDev, mountDir, false);
    return { code: -1, error: e.message };
  }

  // 6. Copy payload in. rsync -a preserves attrs, --info=progress2 prints
  //    a single overall % so updateProgressFromText can drive the bar.
  job.phase = 'copying';
  job.progress = 40;
  try {
    let copyRes;
    if (srcStat.isDirectory()) {
      // Trailing slash on the source so rsync copies the *contents* of the
      // dir, not the dir itself. PS5 ShadowMount+ wants game files at the
      // image root, not nested under a wrapper directory.
      const srcWithSlash = src.endsWith('/') ? src : src + '/';
      copyRes = await spawnLogged(job, helpers, 'rsync', ['-a', '--no-owner', '--no-group', '--info=progress2', srcWithSlash, mountDir + '/']);
    } else {
      // Single file: copy as-is into the mount root.
      const destFile = path.join(mountDir, path.basename(src));
      copyRes = await spawnLogged(job, helpers, 'rsync', ['-a', '--no-owner', '--no-group', '--info=progress2', src, destFile]);
    }
    if (copyRes.code !== 0) {
      appendLog(job, `[manager] rsync failed (code=${copyRes.code}).\n`);
      await cleanupLoop(job, helpers, loopDev, mountDir, true);
      return { code: copyRes.code, error: 'rsync failed' };
    }
  } catch (e) {
    appendLog(job, `[manager] copy error: ${e.message}\n`);
    await cleanupLoop(job, helpers, loopDev, mountDir, true);
    return { code: -1, error: e.message };
  }

  // 7. Flush + unmount + detach. We always try this, even on the success
  //    path, so the loop device is returned to the pool and the mountpoint
  //    cleaned up immediately. Errors here are logged but don't fail the
  //    job — the image on disk is already good.
  job.phase = 'finalizing';
  job.progress = 95;
  await cleanupLoop(job, helpers, loopDev, mountDir, true);
  job.progress = 100;
  job.phase = null;
  return { code: 0 };
}

// Best-effort: sync (when flushFs=true) + umount + losetup -d + rmdir.
// Never throws. We log everything.
async function cleanupLoop(job, helpers, loopDev, mountDir, flushFs) {
  const { appendLog } = helpers;
  if (flushFs) {
    // `sync -f mountDir` flushes only that filesystem instead of the global
    // dirty queue. Cheap and means the umount won't hang on a giant dirty
    // page cache.
    try {
      runSync('sync', ['-f', mountDir || '/']);
    } catch (_) { /* ignore */ }
  }
  if (mountDir) {
    const r = runSync(SUDO, sudoArgs('umount', [mountDir]));
    if (r.code !== 0) {
      // Try lazy unmount as a fallback — keeps the loop device cleanly detachable.
      const lazy = runSync(SUDO, sudoArgs('umount', ['-l', mountDir]));
      if (lazy.code !== 0) {
        appendLog(job, `[manager] WARNING: umount ${mountDir} failed: ${r.stderr || lazy.stderr || `code=${r.code}/${lazy.code}`}\n`);
      } else {
        appendLog(job, `[manager] lazy umount ${mountDir} (will detach when last reference released).\n`);
      }
    }
    try { fs.rmdirSync(mountDir); } catch (_) { /* may still be busy; left to OS reaper */ }
  }
  if (loopDev) {
    const r = runSync(SUDO, sudoArgs('losetup', ['-d', loopDev]));
    if (r.code !== 0) {
      appendLog(job, `[manager] WARNING: losetup -d ${loopDev} failed: ${r.stderr || `code=${r.code}`}\n`);
    } else {
      appendLog(job, `[manager] released ${loopDev}\n`);
    }
  }
}

// ─── Image extract (.exfat → folder) ──────────────────────────────────────

/**
 * Extract a `.exfat` image to a target directory.
 *
 * Loop-mount read-only, rsync everything out, unmount, detach. The target
 * directory is wiped (if it exists) before the copy so an incremental
 * second run produces a clean result rather than mixing old + new files.
 */
export async function unpackExfatImage(job, helpers, imagePath, destDir) {
  const { appendLog } = helpers;
  if (!fs.existsSync(imagePath)) return { code: -1, error: `image not found: ${imagePath}` };

  // Wipe + recreate the destination so the result reflects exactly the
  // current image contents — same semantics as mkpfs unpack with --overwrite.
  job.phase = 'preparing';
  job.progress = 5;
  try {
    if (fs.existsSync(destDir)) {
      const s = fs.statSync(destDir);
      if (s.isDirectory()) fs.rmSync(destDir, { recursive: true, force: true });
      else fs.unlinkSync(destDir);
    }
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    appendLog(job, `[manager] cannot prepare ${destDir}: ${e.message}\n`);
    return { code: -1, error: e.message };
  }

  // Loop attach (read-only).
  job.phase = 'attaching';
  job.progress = 15;
  let loopDev = null;
  {
    const r = runSync(SUDO, sudoArgs('losetup', ['-rfP', '--show', imagePath]));
    if (r.code !== 0 || !r.stdout) {
      appendLog(job, `[manager] losetup failed: ${r.stderr || r.error || `code=${r.code}`}\n`);
      appendLog(job, `[manager] HINT: container needs cap_add: [SYS_ADMIN] + /dev/loop-control.\n`);
      return { code: r.code ?? -1, error: 'losetup failed' };
    }
    loopDev = r.stdout.trim().split('\n').pop();
    appendLog(job, `[manager] loop device (ro): ${loopDev}\n`);
  }

  // Mount (read-only).
  job.phase = 'mounting';
  job.progress = 25;
  let mountDir = null;
  try {
    fs.mkdirSync(MOUNT_ROOT, { recursive: true });
    mountDir = fs.mkdtempSync(path.join(MOUNT_ROOT, 'ext-'));
    // ro mount of the image. uid/gid match the runtime user so rsync can
    // read every file even if the image originally had Windows-side owners.
    const mountRes = await spawnLogged(job, helpers, SUDO, sudoArgs('mount', ['-t', 'exfat', '-o', 'ro,uid=1000,gid=1000', loopDev, mountDir]));
    if (mountRes.code !== 0) {
      appendLog(job, `[manager] mount failed (code=${mountRes.code}).\n`);
      await cleanupLoop(job, helpers, loopDev, mountDir, false);
      return { code: mountRes.code, error: 'mount failed' };
    }
  } catch (e) {
    appendLog(job, `[manager] mount error: ${e.message}\n`);
    await cleanupLoop(job, helpers, loopDev, mountDir, false);
    return { code: -1, error: e.message };
  }

  // rsync the contents out.
  job.phase = 'extracting';
  job.progress = 35;
  try {
    const copyRes = await spawnLogged(job, helpers, 'rsync', ['-a', '--no-owner', '--no-group', '--info=progress2', mountDir + '/', destDir + '/']);
    if (copyRes.code !== 0) {
      appendLog(job, `[manager] rsync failed (code=${copyRes.code}).\n`);
      await cleanupLoop(job, helpers, loopDev, mountDir, false);
      return { code: copyRes.code, error: 'rsync failed' };
    }
  } catch (e) {
    appendLog(job, `[manager] copy error: ${e.message}\n`);
    await cleanupLoop(job, helpers, loopDev, mountDir, false);
    return { code: -1, error: e.message };
  }

  job.phase = 'finalizing';
  job.progress = 95;
  await cleanupLoop(job, helpers, loopDev, mountDir, false);
  job.progress = 100;
  job.phase = null;
  return { code: 0 };
}
