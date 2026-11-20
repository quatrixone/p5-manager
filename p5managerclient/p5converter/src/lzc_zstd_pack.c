/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 P5 Manager.
 *
 * P5 Converter - AMPR zstd asset packs (AMPRZPK1 / AMPRZDT1).
 * Format: docs/zstd.md of github.com/quer3q/ps5-dump-forge (GPL-3.0).
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <zlib.h>  /* crc32: the index's CRC-32 is the IEEE one */
#include <zstd.h>

#include "lzc_zstd_pack.h"

#define FNV64_BASIS 14695981039346656037ULL
#define FNV64_PRIME 1099511628211ULL

uint64_t
lzc_zstd_path_hash(const char *rel, size_t len) {
  uint64_t h = FNV64_BASIS;
  for(size_t i = 0; i < len; i++) {
    h ^= (unsigned char)rel[i];
    h *= FNV64_PRIME;
  }
  return h;
}

/* --- little-endian stores ------------------------------------------------ */

static void
put16(unsigned char *p, uint16_t v) {
  p[0] = (unsigned char)v; p[1] = (unsigned char)(v >> 8);
}

static void
put32(unsigned char *p, uint32_t v) {
  for(int i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i));
}

static void
put64(unsigned char *p, uint64_t v) {
  for(int i = 0; i < 8; i++) p[i] = (unsigned char)(v >> (8 * i));
}

static uint32_t
crc_of(const unsigned char *p, size_t n) {
  return (uint32_t)crc32(crc32(0L, NULL, 0), p, (unsigned)n);
}

/* --- the file table ------------------------------------------------------ */

typedef struct {
  const char *rel;
  size_t rel_len;
  uint64_t size;
  uint64_t hash;
  uint32_t first_chunk;
  uint32_t path_off;
} entry_t;

static int
entry_cmp(const void *a, const void *b) {
  const entry_t *x = a, *y = b;
  if(x->hash != y->hash) return x->hash < y->hash ? -1 : 1;
  size_t n = x->rel_len < y->rel_len ? x->rel_len : y->rel_len;
  int c = memcmp(x->rel, y->rel, n);
  if(c) return c;
  if(x->rel_len == y->rel_len) return 0;
  return x->rel_len < y->rel_len ? -1 : 1;
}

/* A path the format accepts: relative, '/' separated, no empty, "." or ".."
 * part, no backslash or NUL, at most 65535 bytes. */
static int
path_ok(const char *rel, size_t len) {
  if(len == 0 || len > 65535) return 0;
  if(rel[0] == '/' || rel[len - 1] == '/') return 0;
  size_t start = 0;
  for(size_t i = 0; i <= len; i++) {
    if(i < len) {
      if(rel[i] == '\\' || rel[i] == '\0') return 0;
      if(rel[i] != '/') continue;
    }
    size_t part = i - start;
    if(part == 0) return 0;
    if(part == 1 && rel[start] == '.') return 0;
    if(part == 2 && rel[start] == '.' && rel[start + 1] == '.') return 0;
    start = i + 1;
  }
  return 1;
}

static void
fill_archive_id(unsigned char id[16]) {
  int fd = open("/dev/urandom", O_RDONLY);
  if(fd >= 0) {
    ssize_t got = read(fd, id, 16);
    close(fd);
    if(got == 16) return;
  }
  /* Only an identifier repeated in the volume headers, never a secret. */
  uint64_t a = (uint64_t)time(NULL), b = (uint64_t)(uintptr_t)id ^ (uint64_t)getpid();
  put64(id, a * FNV64_PRIME ^ FNV64_BASIS);
  put64(id + 8, b * FNV64_PRIME ^ a);
}

#define FAIL(...) do { if(err && err_size) snprintf(err, err_size, __VA_ARGS__); goto done; } while(0)

/* --- volumes ------------------------------------------------------------- */

typedef struct {
  char root[1024];
  FILE *fp;
  uint32_t id;
  uint64_t off;          /* bytes written, header included */
  uint64_t *sizes;
  uint32_t count;
  uint32_t cap;
} vols_t;

static int
vol_path(const vols_t *v, uint32_t id, char *out, size_t out_size) {
  char name[32];
  snprintf(name, sizeof(name), LZC_ZSTD_VOLUME_FMT, id);
  return snprintf(out, out_size, "%s/%s", v->root, name) < (int)out_size ? 0 : -1;
}

static int
vol_open(vols_t *v, uint32_t id) {
  char path[1200];
  if(vol_path(v, id, path, sizeof(path)) != 0) return -1;
  if(!(v->fp = fopen(path, "wb"))) return -1;
  unsigned char hdr[LZC_ZSTD_VOLUME_HDR];
  memset(hdr, 0, sizeof(hdr));  /* filled in once the count is known */
  if(fwrite(hdr, 1, sizeof(hdr), v->fp) != sizeof(hdr)) return -1;
  v->id = id;
  v->off = LZC_ZSTD_VOLUME_HDR;
  return 0;
}

static int
vol_close(vols_t *v) {
  if(!v->fp) return 0;
  if(fclose(v->fp) != 0) { v->fp = NULL; return -1; }
  v->fp = NULL;
  if(v->count == v->cap) {
    uint32_t cap = v->cap ? v->cap * 2 : 8;
    uint64_t *grown = realloc(v->sizes, (size_t)cap * sizeof(*grown));
    if(!grown) return -1;
    v->sizes = grown;
    v->cap = cap;
  }
  v->sizes[v->count++] = v->off;
  return 0;
}

/* Write every volume's header now that the count and the archive id are
 * settled: the first 64 bytes of each file, nothing else. */
static int
vol_write_headers(const vols_t *v, const unsigned char archive_id[16]) {
  for(uint32_t i = 0; i < v->count; i++) {
    char path[1200];
    if(vol_path(v, i, path, sizeof(path)) != 0) return -1;
    FILE *fp = fopen(path, "r+b");
    if(!fp) return -1;
    unsigned char h[LZC_ZSTD_VOLUME_HDR];
    memset(h, 0, sizeof(h));
    memcpy(h, "AMPRZDT1", 8);
    put32(h + 8, 1);
    put32(h + 12, LZC_ZSTD_VOLUME_HDR);
    put32(h + 16, i);
    put32(h + 20, v->count);
    memcpy(h + 24, archive_id, 16);
    put64(h + 40, v->sizes[i] - LZC_ZSTD_VOLUME_HDR);
    /* The whole 64-byte header with the CRC field zeroed - which it still is
     * here - not just the 60 bytes before it. Getting this wrong makes every
     * reader refuse the volume ("invalid zstd pack volume header") while a
     * reader that skips the check, like ours did, sees nothing wrong. */
    put32(h + 60, crc_of(h, LZC_ZSTD_VOLUME_HDR));
    int bad = fwrite(h, 1, sizeof(h), fp) != sizeof(h);
    if(fclose(fp) != 0 || bad) return -1;
  }
  return 0;
}

/* --- the pack ------------------------------------------------------------ */

int
lzc_zstd_pack(const char *source_root, const char *output_root,
              const lzc_zstd_file_t *files, size_t file_count, int level,
              const lzc_zstd_cb_t *cb, lzc_zstd_stats_t *stats,
              char *err, size_t err_size) {
  int rc = -1;
  entry_t *ents = NULL;
  uint64_t *chunks = NULL;
  size_t chunk_count = 0, chunk_cap = 0;
  unsigned char *raw = NULL, *comp = NULL, *index = NULL;
  ZSTD_CCtx *cctx = NULL;
  FILE *in = NULL;
  vols_t v;

  memset(&v, 0, sizeof(v));
  if(err && err_size) err[0] = 0;
  if(level < 1 || level > 22) FAIL("zstd level must be 1..22 (got %d)", level);
  if(!source_root || !output_root || (!files && file_count)) FAIL("bad arguments");
  if(file_count == 0) FAIL("nothing to pack");
  if(snprintf(v.root, sizeof(v.root), "%s", output_root) >= (int)sizeof(v.root)) {
    FAIL("output path is too long");
  }

  if(!(ents = calloc(file_count, sizeof(*ents)))) FAIL("out of memory");
  uint64_t logical = 0, total_chunks = 0;
  for(size_t i = 0; i < file_count; i++) {
    const char *rel = files[i].rel;
    size_t len = rel ? strlen(rel) : 0;
    if(!path_ok(rel, len)) FAIL("not a packable path: %s", rel ? rel : "(null)");
    ents[i].rel = rel;
    ents[i].rel_len = len;
    ents[i].size = files[i].size;
    ents[i].hash = lzc_zstd_path_hash(rel, len);
    logical += files[i].size;
    total_chunks += (files[i].size + LZC_ZSTD_CHUNK_SIZE - 1) / LZC_ZSTD_CHUNK_SIZE;
  }
  qsort(ents, file_count, sizeof(*ents), entry_cmp);
  for(size_t i = 1; i < file_count; i++) {
    if(entry_cmp(&ents[i - 1], &ents[i]) == 0) FAIL("the same path twice: %s", ents[i].rel);
  }
  if(total_chunks > 0xFFFFFFFFULL) FAIL("too many chunks for one archive");

  size_t comp_cap = ZSTD_compressBound(LZC_ZSTD_CHUNK_SIZE);
  if(!(raw = malloc(LZC_ZSTD_CHUNK_SIZE)) || !(comp = malloc(comp_cap))) FAIL("out of memory");
  if(!(cctx = ZSTD_createCCtx())) FAIL("out of memory");
  /* The frame ampr-emu-ng expects: content size, frame checksum, a window no
   * larger than one chunk, and no dictionary, so every chunk stands alone. */
  if(ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level)) ||
     ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_contentSizeFlag, 1)) ||
     ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_checksumFlag, 1)) ||
     ZSTD_isError(ZSTD_CCtx_setParameter(cctx, ZSTD_c_windowLog, LZC_ZSTD_CHUNK_SHIFT))) {
    FAIL("could not configure the zstd encoder");
  }

  if(vol_open(&v, 0) != 0) FAIL("cannot write %s/" LZC_ZSTD_VOLUME_FMT ": %s", v.root, 0, strerror(errno));

  uint64_t done = 0, stored_total = 0;
  uint32_t n_zstd = 0, n_raw = 0;
  for(size_t i = 0; i < file_count; i++) {
    entry_t *e = &ents[i];
    e->first_chunk = (uint32_t)chunk_count;
    if(cb && cb->current) cb->current(cb->ctx, e->rel);
    if(cb && cb->cancelled && cb->cancelled(cb->ctx)) FAIL("cancelled");
    if(e->size == 0) continue;

    char path[2048];
    if(snprintf(path, sizeof(path), "%s/%s", source_root, e->rel) >= (int)sizeof(path)) {
      FAIL("source path is too long: %s", e->rel);
    }
    if(!(in = fopen(path, "rb"))) FAIL("cannot read %s: %s", e->rel, strerror(errno));

    uint64_t left = e->size;
    while(left) {
      size_t want = left > LZC_ZSTD_CHUNK_SIZE ? LZC_ZSTD_CHUNK_SIZE : (size_t)left;
      if(fread(raw, 1, want, in) != want) FAIL("%s is shorter than its %llu bytes",
                                               e->rel, (unsigned long long)e->size);
      size_t got = ZSTD_compress2(cctx, comp, comp_cap, raw, want);
      const unsigned char *payload;
      size_t stored;
      unsigned codec;
      if(!ZSTD_isError(got) && got < want) {
        payload = comp; stored = got; codec = 1; n_zstd++;
      } else {
        payload = raw; stored = want; codec = 0; n_raw++;
      }

      /* A chunk never straddles two volumes. */
      if(v.off + stored > LZC_ZSTD_VOLUME_LIMIT) {
        uint32_t next = v.id + 1;
        if(next >= LZC_ZSTD_MAX_VOLUMES) FAIL("the archive needs more than %d volumes", LZC_ZSTD_MAX_VOLUMES);
        if(vol_close(&v) != 0) FAIL("cannot finish a volume: %s", strerror(errno));
        if(vol_open(&v, next) != 0) FAIL("cannot write volume %u: %s", next, strerror(errno));
      }
      if(fwrite(payload, 1, stored, v.fp) != stored) FAIL("cannot write a chunk: %s", strerror(errno));

      if(chunk_count == chunk_cap) {
        size_t cap = chunk_cap ? chunk_cap * 2 : 1024;
        uint64_t *grown = realloc(chunks, cap * sizeof(*grown));
        if(!grown) FAIL("out of memory");
        chunks = grown;
        chunk_cap = cap;
      }
      chunks[chunk_count++] = (uint64_t)v.off
        | ((uint64_t)v.id << 32)
        | ((uint64_t)(stored - 1) << 44)
        | ((uint64_t)codec << 62);
      v.off += stored;
      stored_total += stored;
      done += want;
      left -= want;
      if(cb && cb->progress) cb->progress(cb->ctx, done, logical);
      if(cb && cb->cancelled && cb->cancelled(cb->ctx)) FAIL("cancelled");
    }
    if(fclose(in) != 0) { in = NULL; FAIL("cannot close %s", e->rel); }
    in = NULL;
  }
  if(vol_close(&v) != 0) FAIL("cannot finish the last volume: %s", strerror(errno));

  unsigned char archive_id[16];
  fill_archive_id(archive_id);
  if(vol_write_headers(&v, archive_id) != 0) FAIL("cannot write the volume headers: %s", strerror(errno));

  /* The index: header, files, chunks, volumes, strings. */
  uint64_t strings_len = 0;
  for(size_t i = 0; i < file_count; i++) {
    ents[i].path_off = (uint32_t)strings_len;
    strings_len += ents[i].rel_len;
  }
  uint64_t files_off = LZC_ZSTD_INDEX_HDR;
  uint64_t chunks_off = files_off + 32ULL * file_count;
  uint64_t volumes_off = chunks_off + 8ULL * chunk_count;
  uint64_t strings_off = volumes_off + 8ULL * v.count;
  uint64_t index_len = strings_off + strings_len;
  if(!(index = calloc(1, (size_t)index_len))) FAIL("out of memory");

  memcpy(index, "AMPRZPK1", 8);
  put32(index + 8, 1);
  put32(index + 12, LZC_ZSTD_INDEX_HDR);
  index[16] = LZC_ZSTD_CHUNK_SHIFT;
  index[17] = (unsigned char)level;
  put16(index + 18, 0);
  put32(index + 20, v.count);
  memcpy(index + 24, archive_id, 16);
  put64(index + 40, file_count);
  put64(index + 48, chunk_count);
  put64(index + 56, files_off);
  put64(index + 64, chunks_off);
  put64(index + 72, volumes_off);
  put64(index + 80, strings_off);
  put64(index + 88, strings_len);
  put64(index + 96, logical);

  for(size_t i = 0; i < file_count; i++) {
    unsigned char *r = index + files_off + 32 * i;
    put64(r, ents[i].hash);
    put64(r + 8, ents[i].size);
    put32(r + 16, ents[i].first_chunk);
    put32(r + 20, ents[i].path_off);
    put16(r + 24, (uint16_t)ents[i].rel_len);
    put16(r + 26, 0);  /* flags: never store-only */
    memcpy(index + strings_off + ents[i].path_off, ents[i].rel, ents[i].rel_len);
  }
  for(size_t i = 0; i < chunk_count; i++) put64(index + chunks_off + 8 * i, chunks[i]);
  for(uint32_t i = 0; i < v.count; i++) put64(index + volumes_off + 8 * i, v.sizes[i]);

  put32(index + 112, crc_of(index + LZC_ZSTD_INDEX_HDR, (size_t)(index_len - LZC_ZSTD_INDEX_HDR)));
  put32(index + 116, 0);
  {
    unsigned char hdr[LZC_ZSTD_INDEX_HDR];
    memcpy(hdr, index, sizeof(hdr));
    memset(hdr + 112, 0, 8);
    put32(index + 116, crc_of(hdr, sizeof(hdr)));
  }

  {
    char path[1200];
    snprintf(path, sizeof(path), "%s/%s", v.root, LZC_ZSTD_INDEX_NAME);
    FILE *fp = fopen(path, "wb");
    if(!fp) FAIL("cannot write %s: %s", LZC_ZSTD_INDEX_NAME, strerror(errno));
    int bad = fwrite(index, 1, (size_t)index_len, fp) != index_len;
    if(fclose(fp) != 0 || bad) FAIL("cannot write %s: %s", LZC_ZSTD_INDEX_NAME, strerror(errno));
  }

  if(stats) {
    memset(stats, 0, sizeof(*stats));
    stats->file_count = file_count;
    stats->chunk_count = chunk_count;
    stats->logical_bytes = logical;
    stats->stored_bytes = stored_total;
    stats->index_bytes = index_len;
    stats->volume_count = v.count;
    stats->chunks_zstd = n_zstd;
    stats->chunks_raw = n_raw;
    stats->level = level;
    for(uint32_t i = 0; i < v.count; i++) stats->pack_bytes += v.sizes[i];
  }
  rc = 0;

done:
  if(in) fclose(in);
  if(v.fp) fclose(v.fp);
  free(v.sizes);
  free(index);
  free(chunks);
  free(comp);
  free(raw);
  free(ents);
  if(cctx) ZSTD_freeCCtx(cctx);
  return rc;
}

int
lzc_zstd_probe(const char *root) {
  char path[1200];
  if(!root) return 0;
  snprintf(path, sizeof(path), "%s/%s", root, LZC_ZSTD_INDEX_NAME);
  FILE *fp = fopen(path, "rb");
  if(!fp) return 0;
  unsigned char hdr[LZC_ZSTD_INDEX_HDR];
  int ok = fread(hdr, 1, sizeof(hdr), fp) == sizeof(hdr) &&
           memcmp(hdr, "AMPRZPK1", 8) == 0 && hdr[16] == LZC_ZSTD_CHUNK_SHIFT;
  if(ok) {
    unsigned char copy[LZC_ZSTD_INDEX_HDR];
    memcpy(copy, hdr, sizeof(copy));
    memset(copy + 112, 0, 8);
    uint32_t want = (uint32_t)hdr[116] | ((uint32_t)hdr[117] << 8) |
                    ((uint32_t)hdr[118] << 16) | ((uint32_t)hdr[119] << 24);
    ok = crc_of(copy, sizeof(copy)) == want;
  }
  fclose(fp);
  return ok;
}

int
lzc_zstd_is_pack_file(const char *rel) {
  const char *base = rel ? strrchr(rel, '/') : NULL;
  base = base ? base + 1 : rel;
  if(!base) return 0;
  return !strcmp(base, LZC_ZSTD_INDEX_NAME) || !strncmp(base, "ampr_zstd-", 10);
}

/* --- reading the pack set back ------------------------------------------- */

static int
read_at(FILE *fp, uint64_t off, void *buf, size_t n) {
  return (fseeko(fp, (off_t)off, SEEK_SET) == 0 && fread(buf, 1, n, fp) == n) ? 0 : -1;
}

static uint16_t
get16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }

static uint32_t
get32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t
get64(const unsigned char *p) {
  uint64_t v = 0;
  for(int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

static int
mkdirs_to(const char *path) {
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

int
lzc_zstd_unpack(const char *packed_root, const char *output_root,
                const lzc_zstd_cb_t *cb, lzc_zstd_stats_t *stats,
                char *err, size_t err_size) {
  int rc = -1;
  unsigned char *index = NULL, *raw = NULL, *comp = NULL;
  FILE **vols = NULL;
  uint32_t vol_count = 0;
  FILE *out = NULL;
  char path[2048];

  if(err && err_size) err[0] = 0;
  if(stats) memset(stats, 0, sizeof(*stats));
  if(!packed_root || !output_root) FAIL("bad arguments");

  snprintf(path, sizeof(path), "%s/%s", packed_root, LZC_ZSTD_INDEX_NAME);
  FILE *fp = fopen(path, "rb");
  if(!fp) FAIL("cannot read %s: %s", LZC_ZSTD_INDEX_NAME, strerror(errno));
  if(fseeko(fp, 0, SEEK_END) != 0) { fclose(fp); FAIL("cannot read %s", LZC_ZSTD_INDEX_NAME); }
  off_t ilen = ftello(fp);
  rewind(fp);
  if(ilen < LZC_ZSTD_INDEX_HDR || !(index = malloc((size_t)ilen)) ||
     fread(index, 1, (size_t)ilen, fp) != (size_t)ilen) {
    fclose(fp);
    FAIL("%s is damaged", LZC_ZSTD_INDEX_NAME);
  }
  fclose(fp);

  if(memcmp(index, "AMPRZPK1", 8) || get32(index + 8) != 1 ||
     get32(index + 12) != LZC_ZSTD_INDEX_HDR || index[16] != LZC_ZSTD_CHUNK_SHIFT) {
    FAIL("%s is not a zstd pack index this build can read", LZC_ZSTD_INDEX_NAME);
  }
  if(crc_of(index + LZC_ZSTD_INDEX_HDR, (size_t)ilen - LZC_ZSTD_INDEX_HDR) != get32(index + 112)) {
    FAIL("%s failed its checksum", LZC_ZSTD_INDEX_NAME);
  }
  vol_count = get32(index + 20);
  uint64_t file_count = get64(index + 40), chunk_count = get64(index + 48);
  uint64_t files_off = get64(index + 56), chunks_off = get64(index + 64);
  uint64_t strings_off = get64(index + 80), strings_len = get64(index + 88);
  if(!vol_count || vol_count > LZC_ZSTD_MAX_VOLUMES ||
     files_off != LZC_ZSTD_INDEX_HDR ||
     chunks_off != files_off + 32 * file_count ||
     strings_off + strings_len != (uint64_t)ilen) {
    FAIL("%s does not describe a pack set", LZC_ZSTD_INDEX_NAME);
  }

  if(!(vols = calloc(vol_count, sizeof(*vols)))) FAIL("out of memory");
  for(uint32_t v = 0; v < vol_count; v++) {
    char name[32];
    snprintf(name, sizeof(name), LZC_ZSTD_VOLUME_FMT, v);
    snprintf(path, sizeof(path), "%s/%s", packed_root, name);
    if(!(vols[v] = fopen(path, "rb"))) FAIL("cannot read %s: %s", name, strerror(errno));
    unsigned char vh[LZC_ZSTD_VOLUME_HDR];
    if(read_at(vols[v], 0, vh, sizeof(vh)) != 0) FAIL("%s is damaged", name);
    uint32_t want = get32(vh + 60);
    unsigned char copy[LZC_ZSTD_VOLUME_HDR];
    memcpy(copy, vh, sizeof(copy));
    memset(copy + 60, 0, 4);
    if(memcmp(vh, "AMPRZDT1", 8) || get32(vh + 16) != v || get32(vh + 20) != vol_count ||
       memcmp(vh + 24, index + 24, 16) || crc_of(copy, sizeof(copy)) != want) {
      FAIL("%s is not this archive's volume %u", name, v);
    }
  }

  if(!(raw = malloc(LZC_ZSTD_CHUNK_SIZE)) || !(comp = malloc(LZC_ZSTD_CHUNK_SIZE))) FAIL("out of memory");
  if(mkdir(output_root, 0777) != 0 && errno != EEXIST) {
    FAIL("cannot create %s: %s", output_root, strerror(errno));
  }

  uint64_t done = 0, logical_total = get64(index + 96);
  for(uint64_t i = 0; i < file_count; i++) {
    const unsigned char *r = index + files_off + 32 * i;
    uint64_t size = get64(r + 8);
    uint32_t first = get32(r + 16), poff = get32(r + 20);
    uint16_t plen = get16(r + 24);
    char rel[1024];
    if(plen >= sizeof(rel) || poff + plen > strings_len) FAIL("a path in the index is out of range");
    memcpy(rel, index + strings_off + poff, plen);
    rel[plen] = 0;
    if(!path_ok(rel, plen)) FAIL("the index names a path we will not write: %s", rel);
    if(cb && cb->current) cb->current(cb->ctx, rel);
    if(cb && cb->cancelled && cb->cancelled(cb->ctx)) FAIL("cancelled");

    if(snprintf(path, sizeof(path), "%s/%s", output_root, rel) >= (int)sizeof(path)) {
      FAIL("output path is too long: %s", rel);
    }
    if(mkdirs_to(path) != 0) FAIL("cannot create a folder for %s: %s", rel, strerror(errno));
    if(!(out = fopen(path, "wb"))) FAIL("cannot write %s: %s", rel, strerror(errno));

    uint32_t chunks = (uint32_t)((size + LZC_ZSTD_CHUNK_SIZE - 1) / LZC_ZSTD_CHUNK_SIZE);
    for(uint32_t c = 0; c < chunks; c++) {
      if((uint64_t)first + c >= chunk_count) FAIL("%s points past the chunk table", rel);
      uint64_t rec = get64(index + chunks_off + 8 * ((uint64_t)first + c));
      uint32_t off = (uint32_t)(rec & 0xFFFFFFFFULL);
      uint32_t vid = (uint32_t)((rec >> 32) & 0xFFF);
      uint32_t stored = (uint32_t)((rec >> 44) & 0x3FFFF) + 1;
      unsigned codec = (unsigned)(rec >> 62);
      size_t want = size - (uint64_t)c * LZC_ZSTD_CHUNK_SIZE;
      if(want > LZC_ZSTD_CHUNK_SIZE) want = LZC_ZSTD_CHUNK_SIZE;
      if(codec > 1 || vid >= vol_count || off < LZC_ZSTD_VOLUME_HDR) {
        FAIL("chunk %u of %s is not readable", c, rel);
      }
      if(read_at(vols[vid], off, comp, stored) != 0) FAIL("chunk %u of %s is missing", c, rel);
      const unsigned char *src = comp;
      if(codec == 1) {
        size_t got = ZSTD_decompress(raw, LZC_ZSTD_CHUNK_SIZE, comp, stored);
        if(ZSTD_isError(got) || got != want) FAIL("chunk %u of %s does not decode", c, rel);
        src = raw;
      } else if(stored != want) {
        FAIL("chunk %u of %s has the wrong stored size", c, rel);
      }
      if(fwrite(src, 1, want, out) != want) FAIL("cannot write %s: %s", rel, strerror(errno));
      done += want;
      if(cb && cb->progress) cb->progress(cb->ctx, done, logical_total);
      if(cb && cb->cancelled && cb->cancelled(cb->ctx)) FAIL("cancelled");
    }
    if(fclose(out) != 0) { out = NULL; FAIL("cannot finish %s", rel); }
    out = NULL;
    if(chmod(path, 0777) != 0) FAIL("cannot set the mode of %s: %s", rel, strerror(errno));
  }

  if(stats) {
    stats->file_count = file_count;
    stats->chunk_count = chunk_count;
    stats->logical_bytes = done;
    stats->volume_count = vol_count;
  }
  rc = 0;

done:
  if(out) fclose(out);
  for(uint32_t v = 0; vols && v < vol_count; v++) if(vols[v]) fclose(vols[v]);
  free(vols);
  free(comp);
  free(raw);
  free(index);
  return rc;
}
