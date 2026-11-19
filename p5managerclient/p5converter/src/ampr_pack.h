/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - AMPR seekable LZ4 asset packs (AMPRPAK4 / AMPRDAT3).
 *
 * PS5-side port of drakmor's ampr_pack.py, run as one pipeline: build the
 * AMPRIDX3 path index, choose a profile (scan-based "universal"
 * profile or a trace/custom TOML), pack selected files into independently
 * compressed LZ4 blocks, publish the pack set, verify every packed file
 * byte-for-byte against its source and place the remaining loose files.
 * Packed games need the PackedStdio ampr_emu runtime in fakelib/.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

#define AMPR_PACK_INDEX_NAME "ampr_assets.index"
#define AMPR_PACK_RUNTIME_REL "fakelib/libSceAmpr.sprx"

typedef struct ampr_pack_callbacks {
  void *ctx;
  /* A new phase started; phase is a stable id, label is for people. */
  void (*phase)(void *ctx, const char *phase, const char *label);
  /* Byte progress within the current phase. */
  void (*progress)(void *ctx, uint64_t done, uint64_t total);
  /* Relative path currently being processed. */
  void (*current)(void *ctx, const char *rel);
  /* Non-zero aborts the operation. */
  int (*cancelled)(void *ctx);
  /* Diagnostic log line. */
  void (*log)(void *ctx, const char *msg);
} ampr_pack_callbacks_t;

/* Write a new game tree at output_root, leaving source_root untouched. */
#define AMPR_PACK_MODE_COPY     0
/* Pack inside source_root, verify, then delete the originals now stored in
 * the packs (ampr_pack.py remove-packed-sources). */
#define AMPR_PACK_MODE_IN_PLACE 1

typedef struct ampr_pack_options {
  const char *source_root;
  const char *output_root;
  int mode;
  /* Level: 1..4 = LZ4 fast, 5..12 = LZ4 HC at that level. */
  int level;
  /* log2 of the default block size; 16 = 64 KiB. */
  int block_shift;
  int workers;
  int auto_loose_large;
  /* Optional trace-derived or custom TOML profile. */
  const char *profile_path;
  /* Optional folder of TOML profiles to learn loose patterns from. */
  const char *learn_dir;
  /* Pinned PackedStdio runtime. Installed over fakelib/libSceAmpr.sprx. */
  const unsigned char *runtime;
  size_t runtime_size;
  /* Install the runtime as a new fakelib/libSceAmpr.sprx when the game has
   * none (it imports libSceAmpr but ships no APR-EMU). */
  int install_runtime_if_missing;
  /* Copy mode: re-read and compare every copied loose file. */
  int verify_loose_copies;
  ampr_pack_callbacks_t cb;
} ampr_pack_options_t;

typedef struct ampr_pack_stats {
  uint64_t files_total;
  uint64_t files_packed;
  uint64_t files_loose;
  uint64_t files_auto_loose;
  uint64_t chunks;
  uint64_t chunks_lz4;
  uint64_t chunks_raw;
  uint64_t chunks_shared;
  uint64_t logical_bytes;   /* bytes of the files stored in packs */
  uint64_t stored_bytes;    /* chunk payload bytes written */
  uint64_t pack_bytes;      /* total size of the .pak volumes */
  uint64_t loose_bytes;     /* bytes of the files kept loose */
  uint64_t manifest_bytes;
  uint64_t removed_bytes;   /* in-place: originals deleted */
  uint32_t pack_count;
  uint32_t workers;
  uint64_t rt_decoded_cache_bytes;
  uint64_t rt_physical_cache_bytes;
  uint32_t rt_workers;
  uint64_t learned_patterns;
  int runtime_installed;
  int level;
  char build_id[33];
  char profile[32];
} ampr_pack_stats_t;

int ampr_pack_build(const ampr_pack_options_t *opts, ampr_pack_stats_t *stats,
                    char *err, size_t err_size);

/* Validates the manifest, sidecars and every packed chunk. With source_root,
 * also compares every packed file byte-for-byte against that tree. */
int ampr_pack_verify(const char *packed_root, const char *source_root,
                     const ampr_pack_callbacks_t *cb,
                     ampr_pack_stats_t *stats, char *err, size_t err_size);

/* Restores the original loose tree. output_root == NULL unpacks in place and
 * removes the pack set afterwards. */
int ampr_pack_unpack(const char *packed_root, const char *output_root,
                     const ampr_pack_callbacks_t *cb,
                     ampr_pack_stats_t *stats, char *err, size_t err_size);

/* 1 when root contains an AMPRPAK4 manifest with a valid header. Fills the
 * header-level summary (file/chunk/pack counts, build id, pack bytes). */
int ampr_pack_probe(const char *root, ampr_pack_stats_t *stats);

/* Reads the manifest (not the volumes): packed/loose file counts, logical
 * bytes stored in packs, loose bytes and total pack size. */
int ampr_pack_summary(const char *root, ampr_pack_stats_t *stats, char *err,
                      size_t err_size);

/* Cheap check: root/ampr_assets.index exists. */
int ampr_pack_tree_has_manifest(const char *root);

/* Checks that root has the pinned PackedStdio runtime in fakelib/. Another
 * tool's APR-EMU update can swap in a LooseStdio build, which can't read
 * packs (the game starts to a black screen). Returns 0 when it is in place,
 * 1 when it was missing or different (and, with repair, put back), -1 on
 * error. old_sha gets the SHA-256 of the file it replaced ("" if none). */
int ampr_pack_check_runtime(const char *root, int repair, char old_sha[65],
                            char *err, size_t err_size);

/* 1 for files that must stay on disk next to the packs: empty files, PlayGo
 * chunk markers and the boot files Ghost of Yotei looks for. The packer keeps
 * them loose. */
int ampr_pack_keep_on_disk(const char *rel, uint64_t size);

/* Counts packed keep-on-disk files that aren't on disk, and with repair
 * writes them out of the packs (the manifest is unchanged). */
int ampr_pack_restore_disk_files(const char *root, int repair, uint32_t *missing,
                                 uint32_t *restored, char *err, size_t err_size);

/* Embedded PackedStdio runtime (third_party/ampr_emu). */
const unsigned char *ampr_pack_runtime_data(size_t *size);
const char *ampr_pack_runtime_sha256(void);
const char *ampr_pack_runtime_version(void);
