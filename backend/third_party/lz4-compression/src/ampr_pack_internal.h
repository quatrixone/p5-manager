/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - AMPR LZ4 asset packs, private interfaces.
 *
 * Shared by the TOML reader, the profile builder and the packer. The
 * on-disk format is drakmor's ampr_pack.py (AMPRPAK4), so packs built on the
 * PS5 can be checked with the PC tools.
 */

#pragma once

#include <stddef.h>
#include <stdint.h>

/* ------------------------------------------------------------------ TOML */

typedef enum ap_tval_type {
  AP_TV_STRING = 1,
  AP_TV_INT,
  AP_TV_FLOAT,
  AP_TV_BOOL,
  AP_TV_ARRAY,
  AP_TV_TABLE,
} ap_tval_type_t;

typedef struct ap_tval ap_tval_t;

typedef struct ap_tkv {
  char *key;
  ap_tval_t *val;
} ap_tkv_t;

struct ap_tval {
  ap_tval_type_t type;
  char *s;
  int64_t i;
  double f;
  int b;
  /* Arrays (AP_TV_ARRAY) and arrays of tables ([[name]]) share items. */
  ap_tval_t **items;
  size_t count;
  size_t cap;
  int table_array;
  /* Tables. */
  ap_tkv_t *kvs;
  size_t kv_count;
  size_t kv_cap;
  int defined;
};

ap_tval_t *ap_toml_parse(const char *text, size_t len, char *err,
                         size_t err_size);
ap_tval_t *ap_toml_parse_file(const char *path, char *err, size_t err_size);
void ap_toml_free(ap_tval_t *v);
const ap_tval_t *ap_toml_get(const ap_tval_t *table, const char *key);

/* ------------------------------------------------------------- strings */

typedef struct ap_strlist {
  char **items;
  size_t count;
  size_t cap;
} ap_strlist_t;

int ap_strlist_add(ap_strlist_t *l, const char *s);
int ap_strlist_contains(const ap_strlist_t *l, const char *s);
void ap_strlist_free(ap_strlist_t *l);

/* fnmatch.fnmatchcase() semantics: '*' also matches '/'. */
int ap_fnmatch(const char *pattern, const char *name);
/* ampr_pack.glob_matches(): strip leading '/', any pattern matches. */
int ap_glob_matches(const char *rel, const ap_strlist_t *patterns);
/* Profile glob: '*' stays inside one path segment. */
int ap_segment_glob_match(const char *pattern, const char *name);

/* -------------------------------------------------------------- config */

#define AP_ACTION_LOOSE    0
#define AP_ACTION_COMPRESS 1
#define AP_ACTION_STORE    2

#define AP_LAYOUT_AUTO      0
#define AP_LAYOUT_RANDOM    1
#define AP_LAYOUT_MIXED     2
#define AP_LAYOUT_STREAMING 3

#define AP_ASSIGN_BALANCED    0
#define AP_ASSIGN_HASH        1
#define AP_ASSIGN_ROUND_ROBIN 2

#define AP_MIN_BLOCK_SHIFT 14
#define AP_MAX_BLOCK_SHIFT 20
#define AP_MIN_IO_PAGE_SHIFT 12
#define AP_MAX_IO_PAGE_SHIFT 20

typedef struct ap_group {
  char name[64];
  uint32_t pack_count;
  int assignment;
  uint64_t max_pack_size;
  int stripe_large_files;
  uint64_t stripe_threshold;
  uint32_t stripe_group_blocks;
  uint32_t io_page_size;
  uint8_t packing_class;
} ap_group_t;

typedef struct ap_rule {
  int action;
  ap_strlist_t include;
  ap_strlist_t exclude;
  int block_shift;
  int group;
  int mode_hc;
  int level;
  int acceleration;
  uint64_t min_savings_bytes;
  double min_savings_ratio;
  uint64_t io_neutral_min_savings_bytes;
  double io_neutral_min_savings_ratio;
  int layout;
  int streaming;
  int hot;
  int force_pack;
} ap_rule_t;

typedef struct ap_config {
  int has_runtime;
  int runtime_auto_budget;
  uint64_t rt_decoded_cache_bytes;
  uint64_t rt_physical_cache_bytes;
  uint32_t rt_workers;
  uint32_t rt_latency_reserve_workers;

  char index_name[256];
  char pack_pattern[256];
  char pack_output_glob[256];
  int default_action;
  int default_block_shift;
  uint32_t io_page_size;
  uint32_t payload_alignment;
  uint32_t chunk_alignment;
  int workers;
  int mode_hc;
  int level;
  int acceleration;
  uint64_t min_savings_bytes;
  double min_savings_ratio;
  uint64_t io_neutral_min_savings_bytes;
  double io_neutral_min_savings_ratio;
  int deduplicate;
  int dedupe_scope_group;
  int deduplicate_streaming;
  int preserve_mtime;
  int validate_index_metadata;
  int self_contained;
  ap_strlist_t required_packed;
  int auto_loose_large_files;
  int auto_loose_hot_files;
  uint64_t auto_loose_min_file_size;
  uint32_t auto_loose_sample_blocks;
  uint64_t auto_loose_sample_bytes;
  double auto_loose_min_savings_ratio;
  double auto_loose_max_raw_ratio;

  ap_group_t *groups;
  size_t group_count;
  ap_rule_t *rules;
  size_t rule_count;

  /* Paths that always stay loose (safety exclusions). */
  ap_strlist_t force_loose;

  char source[32];
  uint64_t learned_patterns;
} ap_config_t;

typedef struct ap_scan_file {
  char *rel;
  uint64_t size;
  int64_t mtime;
  uint32_t mode;
} ap_scan_file_t;

typedef struct ap_scan {
  ap_scan_file_t *files;
  size_t file_count;
  size_t file_cap;
  ap_strlist_t dirs;
  uint64_t total_bytes;
} ap_scan_t;

void ap_config_init_defaults(ap_config_t *cfg);
void ap_config_free(ap_config_t *cfg);
int ap_config_find_group(const ap_config_t *cfg, const char *name);
int ap_config_finalize(ap_config_t *cfg, char *err, size_t err_size);

/* Loads [pack]/[runtime]/[groups.*]/[[rule]] from a profile TOML. */
int ap_config_load_toml(ap_config_t *cfg, const char *path,
                        int override_level, int override_workers,
                        char *err, size_t err_size);

/* Builds the automatic profile from a scan of the game. */
int ap_config_build_universal(ap_config_t *cfg, const ap_scan_t *scan,
                              int level, int block_shift, int workers,
                              int auto_loose_large, const char *learn_dir,
                              char *err, size_t err_size);

/* Adds the safety exclusions as forced-loose patterns. */
int ap_config_add_safety_exclusions(ap_config_t *cfg);

/* Returns a rule (owned by cfg or the static default) for a relative path. */
const ap_rule_t *ap_config_select_rule(const ap_config_t *cfg,
                                       const char *rel,
                                       ap_rule_t *scratch);

int ap_rule_resolved_layout(const ap_rule_t *rule);

/* Renders pack_pattern ({group}, {lane:02d}, {volume:02d}, {id:03d}). */
int ap_render_pack_name(const ap_config_t *cfg, const char *group,
                        uint32_t lane, uint32_t volume, uint32_t id,
                        char *out, size_t out_size);

int ap_parse_size_text(const char *text, uint64_t *out);
int ap_block_shift_from_size(uint64_t size, int *shift_out);
