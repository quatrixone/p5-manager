# Third-party notices and credits

LZ4 Compression builds on the projects and components below, each under its
own terms. Original copyright notices are kept in the source files.

## Projects it is built on

- **[PS5 Game Compressor](https://github.com/juma-sayeh/PS5-Game-Compressor)**,
  created by Juma Sayeh and tested by Osama Abualia (made with love in
  Palestine). This is the app LZ4 Compression grew out of: the payload, job
  queue, ShadowMountPlus integration, APR-EMU handling, FF-PFSC compression,
  validate and repair, and the `ampr_emu.index` builder. Firmware 13.60,
  ShadowMountPlus 1.7 and rest-mode support are by gcoding97 and Krenar
  ([keieksof's fork](https://github.com/keieksof/PS5-Game-Compressor)), and
  the APR-EMU permission fix is by Zubastic. Their full history is in those
  repositories. The upstream repository has no license file.
- **[Lazy_AMPR](https://github.com/Nazky/Lazy_AMPR)** by Nazky
  ([GitHub](https://github.com/Nazky), [Twitter](https://x.com/NazkyYT)),
  Deckerr97 ([GitHub](https://github.com/kerrdec97)), Pippo
  ([Twitter](https://x.com/itz_pippo)), Drakmor
  ([GitHub](https://github.com/drakmor)) and williamtcastro
  ([GitHub](https://github.com/williamtcastro)). The LZ4 side follows its
  packing workflow, automatic scan-based profile, safety exclusions, learned
  loose patterns and pinned pack-capable APR-EMU runtime.
- **[ampr_emu](https://github.com/drakmor/ampr_emu)**,
  **[ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus)** and
  `build_ampr_index.py` by Drakmor. The LZ4 packer in `src/ampr_pack*.c` is a
  C port of his `ampr_pack.py` (AMPRPAK4 / AMPRDAT3), and packed games are
  read by his APR-EMU runtime.
- **Pippo** (`pippo26442999`) maintains the public APR-EMU manifest and binary
  mirror that the in-app APR-EMU version picker uses.
- **[PSBrew/MkPFS](https://github.com/PSBrew/MkPFS)**, which the PFS image work
  builds on.

The PS5 port of the LZ4 packer and the LZ4 Compression app are by theghostonline,
under the GNU GPL v3 or later (`LICENSE`).

## The PS5 app

The LZ4 Compression app (`app/lz4-compression`, title `PPSA99420`) is built
with PS5 React, created by half144 and PS5 React contributors
(https://github.com/half144/ps5-react), under the GNU GPL v3 or later with its
attribution term. The built app folder carries the framework's own `notices/`
(QuickJS, Embedded React, Inter, HarfBuzz, SheenBidi, libarchive and others).

## Code and binaries in this repository

| Component | Where | License |
| --- | --- | --- |
| LZ4 1.10.0, Copyright (C) Yann Collet | `third_party/lz4/` | BSD-2-Clause |
| zlib 1.3.1, Copyright (C) Jean-loup Gailly and Mark Adler | `third_party/zlib/` | zlib |
| Read-only exFAT image mounts (`src/lzc_image_mount.c`), following the MD backend attach and mount options of [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) by Drakmor | `src/lzc_image_mount.c` | GPL-3.0 |
| Bundled LZ4 profiles (`astrobot.toml`, `ufc6-PPSA23566.toml`, `insomniac.toml`, `unity.toml`), written and tested by danthespal and posted with [MkPFS.CSharp](https://github.com/danthespal/MkPFS.CSharp) | `profiles/` | GPL-3.0 |
| ampr_emu 0.4.2.1 PackedStdio runtime (binary, SHA-256 pinned), by Drakmor; source at [drakmor/ampr_emu](https://github.com/drakmor/ampr_emu) | `third_party/ampr_emu/` | GPL-3.0 |
| miniz (tinfl), by Rich Geldreich | `src/miniz*` | MIT |
| QR Code generator library 1.8.0, Copyright (c) Project Nayuki | `third_party/qrcodegen/` | MIT |
| stb_image, stb_image_resize2, stb_image_write, by Sean Barrett | `src/stb_*.h` | Public domain or MIT |
| `gen-asset-module.py`, Copyright (C) 2024 John Törnblom | repo root | GPL-3.0 |
| Inter typeface, used to draw the logo and home-screen art (the font itself is not included) | `assets-app/`, `assets/lz4-logo.png`, `tools/art/` | SIL Open Font License 1.1 |

The `ORIGIN.md` file in each `third_party/` folder records where that copy came
from and how it was checked.
