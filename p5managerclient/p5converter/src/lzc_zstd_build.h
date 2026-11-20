/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 P5 Manager.
 *
 * P5 Converter - packing a game into AMPR zstd asset packs.
 *
 * Writes a new game tree: the files the LZ4 packer would pack go into
 * AMPRZPK1 packs (lzc_zstd_pack.c), everything else is copied beside them,
 * and fakelib/libSceAmpr.sprx becomes the ampr-emu-ng runtime, which is the
 * only one that reads these packs. The source tree is never touched.
 */

#pragma once

#include "lzc_zstd_pack.h"

typedef struct lzc_zstd_build_opts {
  const char *source_root;
  const char *output_root;
  int level;              /* zstd level 1..22; 0 picks the default, 5 */
  lzc_zstd_cb_t cb;
} lzc_zstd_build_opts_t;

typedef struct lzc_zstd_build_stats {
  lzc_zstd_stats_t pack;
  uint64_t files_loose;
  uint64_t loose_bytes;
  int runtime_installed;
} lzc_zstd_build_stats_t;

/* After lzc_zstd_unpack() has written the packed files into output_root,
 * this copies the files that were never packed, recreates every folder and
 * builds the resolver index for the tree that results. The pack set itself
 * is left behind. */
int lzc_zstd_place_loose(const char *packed_root, const char *output_root,
                         char *err, size_t err_size);

int lzc_zstd_build(const lzc_zstd_build_opts_t *opts,
                   lzc_zstd_build_stats_t *stats, char *err, size_t err_size);

/* Embedded ampr-emu-ng runtime (third_party/ampr_emu_ng). */
const unsigned char *lzc_zstd_runtime_data(size_t *size);
const char *lzc_zstd_runtime_sha256(void);
