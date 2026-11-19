/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline.
 *
 * LZ4 Compression - files a game folder needs before it can boot from
 * ShadowMountPlus, whatever format it is in (loose dump or LZ4 packs).
 */

#pragma once

#include <stddef.h>

typedef struct lzc_boot_report {
  /* The engine folder named by RUNTIME_PATH= in eboot.bin (IOI's Glacier:
   * HITMAN 3, 007 First Light) exists only in another case, e.g. Runtime/
   * for runtime/. The PS5 is case-sensitive, so the game can't open
   * packagedefinition.txt and stops with SIGBUS at boot. */
  int runtime_case_wrong;
  int runtime_renamed;
  char runtime_found[64];
  char runtime_expected[64];
  /* The game imports libScePlayGo and fakelib has no PlayGo library.
   * scePlayGoOpen fails for a game run from a folder, and games that check
   * it stop with SIGBUS at boot. */
  int playgo_missing;
  int playgo_added;
  char playgo_source[512];
  /* eboot.bin is a plain ELF instead of a (fake-)signed SELF. */
  int eboot_plain_elf;
  /* ampr_emu.index (APR-EMU's file list) names a file that isn't on disk at
   * that path and size, e.g. Runtime/ after the folder became runtime/.
   * APR-EMU trusts the index for every /app0 lookup, so the game reads
   * nothing and crashes at boot. Moved aside as ampr_emu.index.stale, it is
   * rebuilt from the real files on the next launch. Unpacked folders only:
   * a packed game's index lists files that live inside the packs. */
  int ampr_index_stale;
  int ampr_index_removed;
  char ampr_index_missing[128];
} lzc_boot_report_t;

/* Directories searched for a PlayGo emulator, in order. Each entry is either
 * a folder holding libScePlayGo.sprx itself, or, with a "games:" prefix, a
 * folder of game folders whose fakelib/ is checked. NULL-terminated. The
 * emulator isn't shipped with the app; it is taken from the console. */
extern const char *const lzc_boot_playgo_sources[];

/* Checks root (a game folder: eboot.bin, sce_sys/, ...). With repair set it
 * renames the runtime folder, copies a PlayGo emulator into fakelib/ and,
 * when packed is 0, moves a stale ampr_emu.index aside; without repair it
 * only reports. sources may be NULL for the defaults.
 * Returns 0, or -1 with a reason in err when a repair failed. */
int lzc_boot_files_check(const char *root, int repair, int packed,
                         const char *const *sources, lzc_boot_report_t *r,
                         char *err, size_t err_size);

/* 1 when the file is a PlayGo emulator (not Sony's libScePlayGo). */
int lzc_boot_is_playgo_emu(const char *path);

/* 1 when the game keeps its data in IOI Glacier .rpkg packages (a runtime/
 * folder, any case, with packagedefinition.txt or *.rpkg in it). Glacier
 * opens those straight from disk, not through APR-EMU: packed, they are gone
 * from disk and the game stops at boot (int 0x42), so it can't be LZ4
 * packed. Seen on 007 First Light 01.018.000; HITMAN 3 has the same layout.
 * Only reads the folder, so the game list can call it for every game. */
int lzc_boot_reads_packages_from_disk(const char *root);
