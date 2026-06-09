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
//   requiresProfile: when true, the UI forces the user to pick a PS5 profile
//                    before loading the template

const MIN = 60 * 1000;

export const DEFAULT_TEMPLATES = [
    {
    id: 'tpl-download-extract-upload',
    name: 'Download → extract → upload to PS5',
    description: 'Download a file, extract it locally, then upload result to PS5 via FTP. Wakes PS5 and holds a Remote Play session so it stays awake through the upload.',
    steps: [
      { type: 'wol', keep_session: true, name: 'Wake PS5 (keep awake)' },
      { type: 'wait', duration: 6000, name: 'Wait 6 seconds' },
      { type: 'download', url: 'https://example.com/archive.zip', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download archive.zip' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/archive.zip', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract archive.zip' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/file.ffpfsc', dest_path: '/data/homebrew', name: 'Upload to PS5 FTP' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-full-pipeline',
    name: 'Full game pipeline',
    description: 'Wake PS5 (holding an RP session so it stays awake), download, extract, convert to .ffpfsc, upload via FTP.',
    steps: [
      { type: 'wol', keep_session: true, name: 'Wake PS5 (keep awake)' },
      { type: 'wait', duration: 6000, name: 'Wait 6 seconds' },
      { type: 'download', url: 'https://example.com/game.rar', dest_kind: 'local', dest_path: '/data/mkpfs', name: 'Download game.rar' },
      { type: 'extract', source: 'local-fs', local_path: '/data/mkpfs/game.rar', dest_kind: 'local-fs', dest_local_path: '/data/mkpfs', name: 'Extract game.rar' },
      { type: 'convert', mode: 'pack-file', source_path: '/data/mkpfs/game.exfat', name: 'Convert to .ffpfsc' },
      { type: 'ftp_upload', local_path: '/data/mkpfs/game.ffpfsc', dest_path: '/data/homebrew', name: 'Upload .ffpfsc to PS5' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-full-game',
    name: 'Full game (RP session → launch script → verify ELF)',
    description: 'Start a Remote Play session, run an input script that launches the game, wait for it to boot, then succeed when the ELF port (9021) is open.',
    steps: [
      { type: 'rp_session', action: 'start', name: 'Start Remote Play session' },
      { type: 'input_script', scriptId: null, scriptName: '(pick after loading template)', script: '// edit this step to pick your launch script', name: 'Run input: launch game' },
      { type: 'wait', duration: 20000, name: 'Wait 20 seconds for game to boot' },
      { type: 'check_port', port: 9021, retryFromStep: 3, retryToStep: 3, name: 'Verify ELF port 9021 (success)' },
      { type: 'rp_session', action: 'stop', name: 'Stop Remote Play session' },
    ],
    requiresProfile: true,
  },
  {
    id: 'tpl-p2jb-jailbreak',
    name: 'p2jb jailbreak (wake → lua → wait 55min → verify ELF)',
    description: 'Wake PS5, wait 15s, send p2jb.lua once the Lua port (9026) is up, wait 55 minutes, then succeed if the ELF port (9021) is reachable.',
    steps: [
      { type: 'wol', name: 'Wake on LAN' },
      { type: 'wait', duration: 15000, name: 'Wait 15 seconds' },
      // Block until Lua port 9026 is available; on failure, retry the wake + wait pair.
      { type: 'check_port', port: 9026, retryFromStep: 1, retryToStep: 2, name: 'Check Lua port 9026 (retry wake on fail)' },
      { type: 'payload', payloadName: 'p2jb.lua', name: 'Send p2jb.lua' },
      { type: 'wait', duration: 55 * MIN, name: 'Wait 55 minutes' },
      // Final verification: ELF port 9021 must be open. No retry → fails the sequence if unreachable.
      { type: 'check_port', port: 9021, retryFromStep: 6, retryToStep: 6, name: 'Verify ELF port 9021 (success)' },
    ],
    requiresProfile: true,
  },
];
