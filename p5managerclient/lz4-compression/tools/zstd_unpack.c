/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Host tool: put the loose files back from an AMPR zstd pack set.
 * Usage: zstd_unpack <archive dir> <output dir>
 * Build and run: tools/zstd_unpack.sh <archive dir> <output dir>
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <zlib.h>
#include <zstd.h>

#include "../src/lzc_zstd_pack.h"

static uint16_t rd16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t rd64(const unsigned char *p) {
  uint64_t v = 0;
  for(int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}

static int mkdirs_for(const char *path) {
  char tmp[4096];
  snprintf(tmp, sizeof(tmp), "%s", path);
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

int main(int argc, char **argv) {
  if(argc != 3) { fprintf(stderr, "usage: %s <archive dir> <output dir>\n", argv[0]); return 2; }
  const char *in = argv[1], *out = argv[2];
  char path[4096];

  snprintf(path, sizeof(path), "%s/%s", in, LZC_ZSTD_INDEX_NAME);
  FILE *f = fopen(path, "rb");
  if(!f) { perror(path); return 1; }
  fseek(f, 0, SEEK_END);
  long ilen = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *ix = malloc((size_t)ilen);
  if(fread(ix, 1, (size_t)ilen, f) != (size_t)ilen) { fprintf(stderr, "short index\n"); return 1; }
  fclose(f);

  if(memcmp(ix, "AMPRZPK1", 8) || ix[16] != LZC_ZSTD_CHUNK_SHIFT) { fprintf(stderr, "not an AMPRZPK1 index\n"); return 1; }
  if(rd32(ix + 112) != (uint32_t)(crc32(crc32(0L, NULL, 0), ix + 128, (unsigned)(ilen - 128)))) {
    fprintf(stderr, "index body CRC mismatch\n"); return 1;
  }
  uint32_t vcount = rd32(ix + 20);
  uint64_t fcount = rd64(ix + 40);
  uint64_t foff = rd64(ix + 56), coff = rd64(ix + 64), soff = rd64(ix + 80);

  FILE **vol = calloc(vcount, sizeof(*vol));
  for(uint32_t v = 0; v < vcount; v++) {
    char name[32];
    snprintf(name, sizeof(name), LZC_ZSTD_VOLUME_FMT, v);
    snprintf(path, sizeof(path), "%s/%s", in, name);
    if(!(vol[v] = fopen(path, "rb"))) { perror(path); return 1; }
  }

  unsigned char *cbuf = malloc(LZC_ZSTD_CHUNK_SIZE), *rbuf = malloc(LZC_ZSTD_CHUNK_SIZE);
  uint64_t written = 0, bytes = 0;
  for(uint64_t i = 0; i < fcount; i++) {
    const unsigned char *r = ix + foff + 32 * i;
    uint64_t size = rd64(r + 8);
    uint32_t fc = rd32(r + 16), poff = rd32(r + 20);
    uint16_t plen = rd16(r + 24);
    char rel[2048];
    memcpy(rel, ix + soff + poff, plen);
    rel[plen] = 0;
    snprintf(path, sizeof(path), "%s/%s", out, rel);
    if(mkdirs_for(path) != 0) { perror(path); return 1; }
    FILE *o = fopen(path, "wb");
    if(!o) { perror(path); return 1; }
    uint32_t n = (uint32_t)((size + LZC_ZSTD_CHUNK_SIZE - 1) / LZC_ZSTD_CHUNK_SIZE);
    for(uint32_t c = 0; c < n; c++) {
      uint64_t rec = rd64(ix + coff + 8 * (fc + c));
      uint32_t off = (uint32_t)(rec & 0xFFFFFFFFULL);
      uint32_t vid = (uint32_t)((rec >> 32) & 0xFFF);
      uint32_t stored = (uint32_t)((rec >> 44) & 0x3FFFF) + 1;
      uint32_t codec = (uint32_t)(rec >> 62);
      size_t logical = size - (uint64_t)c * LZC_ZSTD_CHUNK_SIZE;
      if(logical > LZC_ZSTD_CHUNK_SIZE) logical = LZC_ZSTD_CHUNK_SIZE;
      if(fseeko(vol[vid], (off_t)off, SEEK_SET) != 0 || fread(cbuf, 1, stored, vol[vid]) != stored) {
        fprintf(stderr, "short read in volume %u for %s\n", vid, rel); return 1;
      }
      const unsigned char *src = cbuf;
      if(codec == 1) {
        size_t got = ZSTD_decompress(rbuf, LZC_ZSTD_CHUNK_SIZE, cbuf, stored);
        if(ZSTD_isError(got) || got != logical) { fprintf(stderr, "bad chunk %u of %s\n", c, rel); return 1; }
        src = rbuf;
      } else if(stored != logical) {
        fprintf(stderr, "raw chunk %u of %s has the wrong size\n", c, rel); return 1;
      }
      if(fwrite(src, 1, logical, o) != logical) { perror(path); return 1; }
      bytes += logical;
    }
    if(fclose(o) != 0) { perror(path); return 1; }
    written++;
  }
  printf("restored %llu files, %llu bytes\n", (unsigned long long)written, (unsigned long long)bytes);
  return 0;
}
