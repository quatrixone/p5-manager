// Built-in payloads — auto-downloaded on startup if missing.
//
// Each entry can have:
//   filename:     exact name the manager will store / look up by
//   url:          direct download URL (.elf / .lua / .bin / .zip — zips are
//                 auto-extracted, keeping the first .elf/.lua/.bin found)
//   description:  shown only in logs
//   tag:          marker used to identify what feature requires this payload
//   console_type: 'ps4' | 'ps5' — drives platform filtering in the UI.
//                 Untagged entries render everywhere.
//   port:         default port hint for the payload sender (PS5 ELF/LUA
//                 = 9021 / 9026, PS4 GoldHEN ecosystem = 9020).
//
// Removing an entry stops auto-restore but does not delete files already on
// disk. Add new entries freely; IDs are not used here.

export const ESSENTIAL_PAYLOADS = [
  // ===========================================================================
  // PS5 payloads
  // ===========================================================================

  // --- Required by the Log viewer ----------------------------------------
  {
    filename: 'klogsrv-ps5.elf',
    url: 'https://github.com/ps5-payload-dev/klogsrv/releases/download/v0.8/klogsrv-ps5.elf',
    tag: 'log',
    console_type: 'ps5',
    port: 9021,
    description: 'PS5 Kernel log server (used by Log viewer)',
  },
  {
    filename: 'setlogserver.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/setlogserver.lua',
    tag: 'log',
    console_type: 'ps5',
    port: 9026,
    description: 'PS5 Lua log redirector (used by Log viewer)',
  },

  // --- Required by built-in templates ------------------------------------
  {
    filename: 'p2jb.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/p2jb.lua',
    tag: 'template',
    console_type: 'ps5',
    port: 9026,
    description: 'PS5 p2jb kernel exploit (used by the "p2jb jailbreak" template)',
  },

  // --- Pre-curated convenience PS5 payloads ------------------------------
  {
    filename: 'ps5-backpork.elf',
    url: 'https://github.com/BestPig/BackPork/releases/download/0.1/ps5-backpork.elf',
    tag: 'community',
    console_type: 'ps5',
    port: 9021,
    description: 'PS5 BackPork ELF',
  },
  {
    filename: 'kstuff.elf',
    url: 'https://github.com/EchoStretch/kstuff-lite/releases/download/v1.06/kstuff.elf',
    tag: 'community',
    console_type: 'ps5',
    port: 9021,
    description: 'PS5 kstuff-lite',
  },
  {
    filename: 'micromount.elf',
    url: 'https://github.com/PSBrew/MicroMount/releases/latest/download/micromount.elf',
    tag: 'community',
    console_type: 'ps5',
    port: 9021,
    description: 'PS5 MicroMount ELF loader',
  },

  // ===========================================================================
  // PS4 payloads — modern GoldHEN ecosystem (FW 5.05 → 11.00).
  // All four bind to TCP 9020 (the GoldHEN payload-sender port).
  // URLs target latest GoldHEN release assets so we always ship the
  // newest stable binary; the periodic update-check route can re-fetch.
  // ===========================================================================
  {
    filename: 'goldhen.bin',
    url: 'https://github.com/GoldHEN/GoldHEN/releases/latest/download/goldhen.bin',
    tag: 'community',
    console_type: 'ps4',
    port: 9020,
    description: 'PS4 GoldHEN payload (modern FW 5.05–11.00)',
  },
  {
    filename: 'ftp_server.bin',
    url: 'https://github.com/GoldHEN/GoldHEN_Cheat_Repository/releases/latest/download/ftp_server.bin',
    tag: 'community',
    console_type: 'ps4',
    port: 9020,
    description: 'PS4 GoldHEN FTP server (listens on :2121 after load)',
  },
  {
    filename: 'kernel_debugger.bin',
    url: 'https://github.com/GoldHEN/GoldHEN/releases/latest/download/kernel_debugger.bin',
    tag: 'community',
    console_type: 'ps4',
    port: 9020,
    description: 'PS4 Kernel debugger helper',
  },
];
