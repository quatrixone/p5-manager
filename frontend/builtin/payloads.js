// Built-in payloads — auto-downloaded on startup if missing.
//
// Each entry can have:
//   filename:    exact name the manager will store / look up by
//   url:         direct download URL (.elf / .lua / .zip — zips are
//                auto-extracted, keeping the first .elf/.lua found)
//   description: shown only in logs
//   tag:         marker used to identify what feature requires this payload
//
// Removing an entry stops auto-restore but does not delete files already on
// disk. Add new entries freely; IDs are not used here.

export const ESSENTIAL_PAYLOADS = [
  // --- Required by the Log viewer ----------------------------------------
  {
    filename: 'klogsrv-ps5.elf',
    url: 'https://github.com/ps5-payload-dev/klogsrv/releases/download/v0.8/klogsrv-ps5.elf',
    tag: 'log',
    description: 'Kernel log server (used by Log viewer)',
  },
  {
    filename: 'setlogserver.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/setlogserver.lua',
    tag: 'log',
    description: 'Lua log redirector (used by Log viewer)',
  },

  // --- Required by built-in templates ------------------------------------
  {
    filename: 'p2jb.lua',
    url: 'https://raw.githubusercontent.com/Gezine/Luac0re/main/payloads/p2jb.lua',
    tag: 'template',
    description: 'p2jb kernel exploit (used by the "p2jb jailbreak" template)',
  },

  // --- Pre-curated convenience payloads ----------------------------------
  // klogsrv.elf (john-tornblom/ps5-payload-klogsrv) was removed: the upstream
  // release URL now 404s on every startup. The working kernel log server is
  // already covered by the klogsrv-ps5.elf entry above (ps5-payload-dev/klogsrv).
  {
    filename: 'ps5-backpork.elf',
    url: 'https://github.com/BestPig/BackPork/releases/download/0.1/ps5-backpork.elf',
    tag: 'community',
    description: 'BackPork ELF',
  },
  {
    filename: 'kstuff.elf',
    url: 'https://github.com/EchoStretch/kstuff-lite/releases/download/v1.06/kstuff.elf',
    tag: 'community',
    description: 'kstuff-lite',
  },
  {
    filename: 'micromount.elf',
    url: 'https://github.com/PSBrew/MicroMount/releases/latest/download/micromount.elf',
    tag: 'community',
    description: 'MicroMount ELF loader',
  },
];
