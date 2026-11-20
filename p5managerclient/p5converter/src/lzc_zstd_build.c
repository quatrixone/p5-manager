/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 P5 Manager.
 *
 * P5 Converter - packing a game into AMPR zstd asset packs.
 */

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "ampr_index.h"
#include "ampr_pack.h"
#include "ampr_pack_internal.h"
#include "lzc_zstd_build.h"
#include "lzc_zstd_pack.h"

#define LZC_ZSTD_DEFAULT_LEVEL 5

extern const unsigned char lzc_ampr_ng_runtime_blob[];
extern const size_t lzc_ampr_ng_runtime_blob_size;
extern const char lzc_ampr_ng_runtime_blob_sha256[];

const unsigned char *
lzc_zstd_runtime_data(size_t *size) {
  if(size) *size = lzc_ampr_ng_runtime_blob_size;
  return lzc_ampr_ng_runtime_blob;
}

const char *
lzc_zstd_runtime_sha256(void) {
  return lzc_ampr_ng_runtime_blob_sha256;
}

#define FAIL(...) do { if(err && err_size && !err[0]) snprintf(err, err_size, __VA_ARGS__); goto done; } while(0)

/* mkdir -p for the directory part of a path already rooted at an existing
 * directory. */
static int
mkdirs_for(const char *path) {
  char tmp[2048];
  if(snprintf(tmp, sizeof(tmp), "%s", path) >= (int)sizeof(tmp)) return -1;
  char *slash = strrchr(tmp, '/');
  if(!slash) return 0;
  *slash = 0;
  for(char *p = tmp + 1; *p; p++) {
    if(*p != '/') continue;
    *p = 0;
    if(mkdir(tmp, 0777) != 0 && errno != EEXIST) return -1;
    *p = '/';
  }
  return (mkdir(tmp, 0777) != 0 && errno != EEXIST) ? -1 : 0;
}

static int
copy_file(const char *from, const char *to, uint64_t *bytes) {
  FILE *in = fopen(from, "rb");
  if(!in) return -1;
  if(mkdirs_for(to) != 0) { fclose(in); return -1; }
  FILE *out = fopen(to, "wb");
  if(!out) { fclose(in); return -1; }
  char buf[1 << 16];
  size_t n;
  int bad = 0;
  while((n = fread(buf, 1, sizeof(buf), in)) > 0) {
    if(fwrite(buf, 1, n, out) != n) { bad = 1; break; }
    if(bytes) *bytes += n;
  }
  if(ferror(in)) bad = 1;
  fclose(in);
  if(fclose(out) != 0) bad = 1;
  return bad ? -1 : 0;
}

/* Depth-first walk collecting regular files, relative to root. */
static int
walk(const char *root, const char *rel, ap_scan_t *scan) {
  char dir[2048];
  if(snprintf(dir, sizeof(dir), rel[0] ? "%s/%s" : "%s", root, rel) >= (int)sizeof(dir)) return -1;
  DIR *d = opendir(dir);
  if(!d) return -1;
  struct dirent *e;
  int rc = 0;
  while(rc == 0 && (e = readdir(d))) {
    if(!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    char child[2048], path[2048];
    if(snprintf(child, sizeof(child), rel[0] ? "%s/%s" : "%s%s", rel, e->d_name) >= (int)sizeof(child) ||
       snprintf(path, sizeof(path), "%s/%s", root, child) >= (int)sizeof(path)) { rc = -1; break; }
    struct stat st;
    if(lstat(path, &st) != 0) { rc = -1; break; }
    if(S_ISDIR(st.st_mode)) {
      /* The automatic profile builds its rules from the folder names, so a
       * scan without them keeps every file loose. */
      if(ap_strlist_add(&scan->dirs, child) != 0) { rc = -1; break; }
      rc = walk(root, child, scan);
    } else if(S_ISREG(st.st_mode)) {
      if(scan->file_count == scan->file_cap) {
        size_t cap = scan->file_cap ? scan->file_cap * 2 : 256;
        ap_scan_file_t *grown = realloc(scan->files, cap * sizeof(*grown));
        if(!grown) { rc = -1; break; }
        scan->files = grown;
        scan->file_cap = cap;
      }
      ap_scan_file_t *f = &scan->files[scan->file_count];
      memset(f, 0, sizeof(*f));
      f->rel = strdup(child);
      if(!f->rel) { rc = -1; break; }
      f->size = (uint64_t)st.st_size;
      f->mtime = (int64_t)st.st_mtime;
      f->mode = (uint32_t)st.st_mode;
      scan->file_count++;
      scan->total_bytes += f->size;
    }
    /* Anything else (links, devices) is left behind on purpose. */
  }
  closedir(d);
  return rc;
}

static void
scan_free(ap_scan_t *s) {
  for(size_t i = 0; i < s->file_count; i++) free(s->files[i].rel);
  free(s->files);
  ap_strlist_free(&s->dirs);
  memset(s, 0, sizeof(*s));
}

/* Files of an existing pack set, never packed again. */
static int
is_pack_artifact(const char *rel) {
  const char *base = strrchr(rel, '/');
  base = base ? base + 1 : rel;
  if(!strcmp(base, LZC_ZSTD_INDEX_NAME)) return 1;
  if(!strncmp(base, "ampr_zstd-", 10)) return 1;
  if(!strcmp(base, AMPR_PACK_INDEX_NAME)) return 1;
  if(!strncmp(base, "ampr_assets", 11)) return 1;
  return 0;
}

/* The APR resolver index is rebuilt for the tree we write, never copied: the
 * runtime turns a fileId into a path through it, and the source's own index
 * numbers a different set of files, so a copy makes it read the wrong one
 * (EIO on a pack read, then the game dies on the AIO completion). These are
 * the root files ampr_pack.c keeps out of it. */
static int
is_apr_index_file(const char *rel) {
  if(strchr(rel, '/')) return 0;
  return !strcmp(rel, "ampr_emu.index") || !strcmp(rel, "ampr_emu.index.tmp") ||
         !strcmp(rel, "ampr_commands.bin") || !strcmp(rel, "apr_emu.log");
}

static int
build_apr_index(const char *output_root, const ap_scan_t *scan, char *err,
                size_t err_size) {
  ampr_index_entry_t *entries = calloc(scan->file_count, sizeof(*entries));
  if(!entries) {
    if(err && err_size) snprintf(err, err_size, "out of memory");
    return -1;
  }
  size_t n = 0;
  for(size_t i = 0; i < scan->file_count; i++) {
    if(is_apr_index_file(scan->files[i].rel)) continue;
    entries[n].rel = scan->files[i].rel;
    entries[n].size = scan->files[i].size;
    entries[n].mtime = scan->files[i].mtime;
    n++;
  }
  int rc = n ? ampr_index_build_from_entries(output_root, entries, n, 0, NULL,
                                             err, err_size)
             : -1;
  if(!n && err && err_size) snprintf(err, err_size, "no files to index");
  free(entries);
  return rc;
}

int
lzc_zstd_build(const lzc_zstd_build_opts_t *opts, lzc_zstd_build_stats_t *stats,
               char *err, size_t err_size) {
  int rc = -1;
  ap_scan_t scan;
  ap_config_t cfg;
  lzc_zstd_file_t *packed = NULL;
  size_t packed_count = 0;

  memset(&scan, 0, sizeof(scan));
  memset(&cfg, 0, sizeof(cfg));
  ap_config_init_defaults(&cfg);
  if(stats) memset(stats, 0, sizeof(*stats));
  if(err && err_size) err[0] = 0;
  if(!opts || !opts->source_root || !opts->output_root) FAIL("bad arguments");

  int level = opts->level ? opts->level : LZC_ZSTD_DEFAULT_LEVEL;
  if(level < 1 || level > 22) FAIL("zstd level must be 1..22 (got %d)", level);

  if(walk(opts->source_root, "", &scan) != 0) FAIL("cannot read %s: %s", opts->source_root, strerror(errno));
  if(scan.file_count == 0) FAIL("there are no files to pack in %s", opts->source_root);

  /* The same choice of files the LZ4 packer makes: the automatic profile
   * plus the safety exclusions, so the boot files stay loose. */
  if(ap_config_build_universal(&cfg, &scan, 9, 16, 1, 0, NULL, err, err_size) != 0) goto done;
  if(ap_config_add_safety_exclusions(&cfg) != 0) FAIL("out of memory");
  if(ap_config_finalize(&cfg, err, err_size) != 0) goto done;

  if(!(packed = calloc(scan.file_count, sizeof(*packed)))) FAIL("out of memory");
  if(mkdir(opts->output_root, 0777) != 0 && errno != EEXIST) {
    FAIL("cannot create %s: %s", opts->output_root, strerror(errno));
  }
  /* Every folder, not just the ones a copied file creates: a game can need a
   * directory that happens to be empty, and losing it is not a copy. */
  for(size_t i = 0; i < scan.dirs.count; i++) {
    char dir[2048];
    if(snprintf(dir, sizeof(dir), "%s/%s/.", opts->output_root, scan.dirs.items[i]) >= (int)sizeof(dir)) {
      FAIL("path is too long: %s", scan.dirs.items[i]);
    }
    if(mkdirs_for(dir) != 0) FAIL("cannot create %s: %s", scan.dirs.items[i], strerror(errno));
  }

  for(size_t i = 0; i < scan.file_count; i++) {
    const ap_scan_file_t *f = &scan.files[i];
    ap_rule_t scratch;
    const ap_rule_t *rule = ap_config_select_rule(&cfg, f->rel, &scratch);
    int loose = !rule || rule->action == AP_ACTION_LOOSE
                || ap_glob_matches(f->rel, &cfg.force_loose)
                || ampr_pack_keep_on_disk(f->rel, f->size)
                || is_pack_artifact(f->rel)
                || is_apr_index_file(f->rel)
                || f->size == 0;
    if(loose) {
      char from[2048], to[2048];
      if(snprintf(from, sizeof(from), "%s/%s", opts->source_root, f->rel) >= (int)sizeof(from) ||
         snprintf(to, sizeof(to), "%s/%s", opts->output_root, f->rel) >= (int)sizeof(to)) {
        FAIL("path is too long: %s", f->rel);
      }
      uint64_t copied = 0;
      if(copy_file(from, to, &copied) != 0) FAIL("cannot copy %s: %s", f->rel, strerror(errno));
      if(chmod(to, 0777) != 0) FAIL("cannot set the mode of %s: %s", f->rel, strerror(errno));
      if(stats) { stats->files_loose++; stats->loose_bytes += copied; }
    } else {
      packed[packed_count].rel = f->rel;
      packed[packed_count].size = f->size;
      packed_count++;
    }
    if(opts->cb.cancelled && opts->cb.cancelled(opts->cb.ctx)) FAIL("cancelled");
  }
  if(packed_count == 0) FAIL("every file in this game has to stay loose - nothing to pack");

  if(lzc_zstd_pack(opts->source_root, opts->output_root, packed, packed_count,
                   level, &opts->cb, stats ? &stats->pack : NULL, err, err_size) != 0) {
    goto done;
  }

  /* The resolver index for the tree we just wrote, not the source's. */
  if(build_apr_index(opts->output_root, &scan, err, err_size) != 0) goto done;

  /* Without this runtime the game cannot read what we just wrote. */
  {
    char to[2048];
    if(snprintf(to, sizeof(to), "%s/%s", opts->output_root, AMPR_PACK_RUNTIME_REL) >= (int)sizeof(to)) {
      FAIL("output path is too long");
    }
    if(mkdirs_for(to) != 0) FAIL("cannot create fakelib: %s", strerror(errno));
    size_t size = 0;
    const unsigned char *blob = lzc_zstd_runtime_data(&size);
    FILE *fp = fopen(to, "wb");
    if(!fp) FAIL("cannot write the ampr-emu-ng runtime: %s", strerror(errno));
    int bad = fwrite(blob, 1, size, fp) != size;
    if(fclose(fp) != 0 || bad) FAIL("cannot write the ampr-emu-ng runtime: %s", strerror(errno));
    /* The module loader refuses a runtime without the execute bit, and the
     * game then dies with "failed to open descriptor file" - so set the mode
     * here rather than leaving it to a later pass over the tree. */
    if(chmod(to, 0777) != 0) FAIL("cannot set the runtime's mode: %s", strerror(errno));
    if(stats) stats->runtime_installed = 1;
  }
  rc = 0;

done:
  free(packed);
  ap_config_free(&cfg);
  scan_free(&scan);
  return rc;
}

int
lzc_zstd_place_loose(const char *packed_root, const char *output_root,
                     char *err, size_t err_size) {
  int rc = -1;
  ap_scan_t packed;
  ap_scan_t placed;

  memset(&packed, 0, sizeof(packed));
  memset(&placed, 0, sizeof(placed));
  if(err && err_size) err[0] = 0;
  if(!packed_root || !output_root) FAIL("bad arguments");
  if(walk(packed_root, "", &packed) != 0) FAIL("cannot read %s: %s", packed_root, strerror(errno));

  for(size_t i = 0; i < packed.dirs.count; i++) {
    char dir[2048];
    if(snprintf(dir, sizeof(dir), "%s/%s/.", output_root, packed.dirs.items[i]) >= (int)sizeof(dir)) {
      FAIL("path is too long: %s", packed.dirs.items[i]);
    }
    if(mkdirs_for(dir) != 0) FAIL("cannot create %s: %s", packed.dirs.items[i], strerror(errno));
  }
  for(size_t i = 0; i < packed.file_count; i++) {
    const char *rel = packed.files[i].rel;
    char from[2048], to[2048];
    struct stat st;
    /* The pack set stays behind, and the index is rebuilt below. */
    if(lzc_zstd_is_pack_file(rel) || is_apr_index_file(rel)) continue;
    if(snprintf(to, sizeof(to), "%s/%s", output_root, rel) >= (int)sizeof(to) ||
       snprintf(from, sizeof(from), "%s/%s", packed_root, rel) >= (int)sizeof(from)) {
      FAIL("path is too long: %s", rel);
    }
    /* A file the packs already restored is the authority; never overwrite it. */
    if(stat(to, &st) == 0) continue;
    if(copy_file(from, to, NULL) != 0) FAIL("cannot copy %s: %s", rel, strerror(errno));
    if(chmod(to, 0777) != 0) FAIL("cannot set the mode of %s: %s", rel, strerror(errno));
  }

  if(walk(output_root, "", &placed) != 0) FAIL("cannot read %s: %s", output_root, strerror(errno));
  if(build_apr_index(output_root, &placed, err, err_size) != 0) goto done;
  rc = 0;

done:
  scan_free(&placed);
  scan_free(&packed);
  return rc;
}
