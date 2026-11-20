/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 P5 Manager.
 *
 * P5 Converter - AMPR zstd asset packs (AMPRZPK1 / AMPRZDT1).
 *
 * The container ps5-dump-forge writes and ampr-emu-ng reads: an index
 * (ampr_zstd.index) plus numbered volumes (ampr_zstd-NNN.pak) holding the
 * game's files in independently decodable 256 KiB zstd frames. This is a
 * different container from the LZ4 packs (AMPRPAK4/AMPRDAT3, ampr_pack.c)
 * and needs the ampr-emu-ng runtime in fakelib/, not PackedStdio.
 *
 * Format: docs/zstd.md of github.com/quer3q/ps5-dump-forge (GPL-3.0).
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#define LZC_ZSTD_INDEX_NAME   "ampr_zstd.index"
#define LZC_ZSTD_VOLUME_FMT   "ampr_zstd-%03u.pak"
#define LZC_ZSTD_CHUNK_SHIFT  18
#define LZC_ZSTD_CHUNK_SIZE   (1u << LZC_ZSTD_CHUNK_SHIFT)   /* 256 KiB */
#define LZC_ZSTD_VOLUME_LIMIT 4294901760ULL                  /* 4 GiB - 64 KiB */
#define LZC_ZSTD_MAX_VOLUMES  4096
#define LZC_ZSTD_INDEX_HDR    128
#define LZC_ZSTD_VOLUME_HDR   64

/* One file to pack, path relative to the game root with '/' separators. */
typedef struct lzc_zstd_file {
  const char *rel;
  uint64_t size;
} lzc_zstd_file_t;

typedef struct lzc_zstd_cb {
  void *ctx;
  void (*progress)(void *ctx, uint64_t done, uint64_t total);
  void (*current)(void *ctx, const char *rel);
  int (*cancelled)(void *ctx);
} lzc_zstd_cb_t;

typedef struct lzc_zstd_stats {
  uint64_t file_count;
  uint64_t chunk_count;
  uint64_t logical_bytes;  /* bytes of the packed files */
  uint64_t stored_bytes;   /* chunk payload written */
  uint64_t pack_bytes;     /* volumes, headers included */
  uint64_t index_bytes;
  uint32_t volume_count;
  uint32_t chunks_zstd;
  uint32_t chunks_raw;
  int level;
} lzc_zstd_stats_t;

/* Packs `files` (read under source_root) into output_root as AMPRZPK1.
 * Returns 0, or -1 with a message in err. Level is 1..22. */
int lzc_zstd_pack(const char *source_root, const char *output_root,
                  const lzc_zstd_file_t *files, size_t file_count, int level,
                  const lzc_zstd_cb_t *cb, lzc_zstd_stats_t *stats,
                  char *err, size_t err_size);

/* 1 when root holds an ampr_zstd.index with a valid header. */
int lzc_zstd_probe(const char *root);

/* Writes the packed files back as loose files under output_root, then the
 * caller places the loose files and drops the pack set. Every chunk is
 * checked against the record it came from. */
int lzc_zstd_unpack(const char *packed_root, const char *output_root,
                    const lzc_zstd_cb_t *cb, lzc_zstd_stats_t *stats,
                    char *err, size_t err_size);

/* 1 for the files that belong to a zstd pack set (the index and volumes). */
int lzc_zstd_is_pack_file(const char *rel);

/* FNV-1a 64 over the relative path, as the index sorts and looks up by. */
uint64_t lzc_zstd_path_hash(const char *rel, size_t len);
