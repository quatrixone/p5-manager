// Built-in Autoload sequence templates.
//
// Returned verbatim by GET /api/sequences/templates/list and surfaced in the
// AutoloadBuilder "Templates" panel. Editing this file changes what the user
// sees on next reload — no DB migration needed.
//
// Each template:
//   id:              stable identifier; do NOT change once shipped
//   name:            shown in the UI
//   description:     short blurb shown beneath the name
//   steps:           array of step objects identical to a saved sequence
//   requiresProfile: when true, the UI forces the user to pick a profile
//                    before loading the template
//   console_type:    'ps4' | 'ps5' | undefined. Drives the AutoloadBuilder
//                    template gallery: in PS4 mode only ps4 + untagged
//                    templates show, in PS5 mode only ps5 + untagged,
//                    "All" shows everything. Untagged = cross-platform
//                    (e.g. generic download-then-upload pipelines).

const MIN = 60 * 1000;

// Convention for PS5 / cross-platform templates:
//   - First step is always `rp_session start` — pyremoteplay's quick-start
//     wakes the console from rest (DDP), opens the RP session, dismisses
//     the account picker, and parks it in the warm cache. Replaces the old
//     `wol + wait` header in one step and guarantees the console is fully
//     ready (not just powered on) before the rest of the pipeline runs.
//   - Last step is always `rp_session standby` — uses the same RP session
//     to put the console into rest mode when the work is done so the user
//     doesn't return to a screen-on PS5.
// Both bookends require the profile to be PSN-linked + RP-paired (do that
// once in P5 Control → Remote Play Settings). PS4 templates skip this
// because they don't go through pyremoteplay.

export const DEFAULT_TEMPLATES = [
    {
    id: 'tpl-download-extract-upload',
    name: 'Download → extract → upload (cross-platform)',
    description: 'Open a Remote Play session (keeps the console awake), download a file, extract it locally, upload the result via FTP, then rest mode. Works for PS4 (GoldHEN FTP) or PS5 — adjust the destination path to your console.',
    steps: [
      { type: 'rp_session', action: 'start', name: 'Start Remote Play session' },
      { type: 'download', url: 'https://example.com/archive.zip', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download archive.zip' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/archive.zip', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract archive.zip' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/file.ffpfsc', dest_path: '/data/homebrew', name: 'Upload to console FTP' },
      { type: 'rp_session', action: 'standby', name: 'Console rest mode' },
    ],
    requiresProfile: true,
    // no console_type → renders in every mode (cross-platform template)
  },
  {
    id: 'tpl-full-pipeline',
    name: 'PS5: Full game pipeline (download → extract → mkpfs → FTP)',
    description: 'Open a Remote Play session (holds PS5 awake), download, extract, convert to .ffpfsc, upload via FTP, then rest mode. PS5-specific because of the mkpfs pack step.',
    steps: [
      { type: 'rp_session', action: 'start', name: 'Start Remote Play session' },
      { type: 'download', url: 'https://example.com/game.rar', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download game.rar' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/game.rar', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract game.rar' },
      { type: 'convert', mode: 'pack-file', source_path: '/data/mkpfs/game.exfat', name: 'Convert to .ffpfsc' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/game.ffpfsc', dest_path: '/data/homebrew', name: 'Upload .ffpfsc to PS5' },
      { type: 'rp_session', action: 'standby', name: 'Console rest mode' },
    ],
    requiresProfile: true,
    console_type: 'ps5',
  },
  {
    id: 'tpl-p2jb-jailbreak',
    name: 'PS5: p2jb jailbreak (start session → lua → wait 55min → verify ELF → rest mode)',
    description: 'Open Remote Play session, wait 15s for the Lua port (9026) to be up, send p2jb.lua, wait 55 minutes, verify the ELF port (9021) is reachable, then rest mode.',
    steps: [
      // Step 1 — RP session: opens the link and wakes the PS5 if it was asleep.
      { type: 'rp_session', action: 'start', name: 'Start Remote Play session' },
      // Step 2 — give the Lua exploit listener time to come up.
      { type: 'wait', duration: 15000, name: 'Wait 15 seconds' },
      // Step 3 — block until Lua port 9026 is reachable; on failure retry steps 1-2 (re-open RP + wait).
      { type: 'check_port', port: 9026, retryFromStep: 1, retryToStep: 2, name: 'Check Lua port 9026 (retry on fail)' },
      // Step 4 — fire the actual exploit.
      { type: 'payload', payloadName: 'p2jb.lua', name: 'Send p2jb.lua' },
      // Step 5 — p2jb prep takes ~55 min to complete the kexploit.
      { type: 'wait', duration: 55 * MIN, name: 'Wait 55 minutes' },
      // Step 6 — final verification: ELF port 9021 must be open. No retry → fails the sequence if unreachable.
      { type: 'check_port', port: 9021, retryFromStep: 6, retryToStep: 6, name: 'Verify ELF port 9021 (success)' },
      // Step 7 — done; put the console back to sleep.
      { type: 'rp_session', action: 'standby', name: 'Console rest mode' },
    ],
    requiresProfile: true,
    console_type: 'ps5',
  },

  // ===========================================================================
  // PS4 templates (modern GoldHEN ecosystem, FW 5.05 → 11.00).
  // GoldHEN binaries land on TCP 9020; once loaded the FTP server payload
  // exposes :2121 for file ops. The "full flow" template chains them so the
  // user gets a jailbroken-and-FTP-ready console in a single click.
  // ===========================================================================
  {
    id: 'tpl-goldhen-load',
    name: 'PS4: Load GoldHEN (wake → wait → send goldhen.bin)',
    description: 'Wake the PS4, wait 8 seconds for the WebKit exploit page to be reachable, send goldhen.bin to TCP 9020, then verify the payload-sender port stayed open.',
    steps: [
      { type: 'wol', name: 'Wake on LAN' },
      { type: 'wait', duration: 8000, name: 'Wait 8 seconds' },
      // Retry the wake + wait pair if 9020 isn't reachable yet — PS4 takes
      // longer than PS5 to open the GoldHEN exploit listener.
      { type: 'check_port', port: 9020, retryFromStep: 1, retryToStep: 2, name: 'Check GoldHEN port 9020 (retry wake on fail)' },
      { type: 'payload', payloadName: 'goldhen.bin', name: 'Send goldhen.bin' },
    ],
    requiresProfile: true,
    console_type: 'ps4',
  },
  {
    id: 'tpl-goldhen-full-flow',
    name: 'PS4: GoldHEN + FTP ready (wake → load → start FTP → verify :2121)',
    description: 'Full GoldHEN bring-up: wake the PS4, load goldhen.bin, then load ftp_server.bin and succeed when port 2121 (FTP) is open so you can immediately browse the PS4 from the File Ops tab.',
    steps: [
      { type: 'wol', name: 'Wake on LAN' },
      { type: 'wait', duration: 8000, name: 'Wait 8 seconds' },
      { type: 'check_port', port: 9020, retryFromStep: 1, retryToStep: 2, name: 'Check GoldHEN port 9020 (retry wake on fail)' },
      { type: 'payload', payloadName: 'goldhen.bin', name: 'Send goldhen.bin' },
      { type: 'wait', duration: 4000, name: 'Wait 4 seconds for jailbreak to settle' },
      { type: 'payload', payloadName: 'ftp_server.bin', name: 'Send ftp_server.bin' },
      { type: 'wait', duration: 3000, name: 'Wait 3 seconds for FTP to bind' },
      // Final verification: FTP server port. No retry → fails if unreachable.
      { type: 'check_port', port: 2121, retryFromStep: 8, retryToStep: 8, name: 'Verify FTP port 2121 (success)' },
    ],
    requiresProfile: true,
    console_type: 'ps4',
  },
];
