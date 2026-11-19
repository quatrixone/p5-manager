/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Host test for lzc_zstd_pack: packs a tree, then reads the archive back
 * strictly by docs/zstd.md and compares every chunk with its source bytes.
 * Build and run: tools/zstd_pack_test.sh
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <zlib.h>
#include <zstd.h>

#include "../src/lzc_zstd_pack.h"

static int failures = 0;
#define CHECK(cond, ...) do { if(!(cond)) { printf("  FAIL "); printf(__VA_ARGS__); printf("\n"); failures++; } } while(0)

static uint16_t rd16(const unsigned char *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t rd64(const unsigned char *p) {
  uint64_t v = 0;
  for(int i = 7; i >= 0; i--) v = (v << 8) | p[i];
  return v;
}
static uint32_t crc_of(const unsigned char *p, size_t n) {
  return (uint32_t)crc32(crc32(0L, NULL, 0), p, (unsigned)n);
}

static unsigned char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if(!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char *b = malloc(n ? (size_t)n : 1);
  if(fread(b, 1, (size_t)n, f) != (size_t)n) { fclose(f); free(b); return NULL; }
  fclose(f);
  *len = (size_t)n;
  return b;
}

static void write_file(const char *root, const char *rel, const unsigned char *data, size_t n) {
  char path[2048], dir[2048];
  snprintf(path, sizeof(path), "%s/%s", root, rel);
  snprintf(dir, sizeof(dir), "%s", path);
  char *slash = strrchr(dir, '/');
  if(slash) { *slash = 0; char cmd[1100]; snprintf(cmd, sizeof(cmd), "mkdir -p '%s'", dir); if(system(cmd)) {} }
  FILE *f = fopen(path, "wb");
  if(n) fwrite(data, 1, n, f);
  fclose(f);
}

int main(int argc, char **argv) {
  const char *tmp = argc > 1 ? argv[1] : "/tmp/zstd-pack-test";
  char src[1024], out[1024], cmd[2200];
  snprintf(src, sizeof(src), "%s/src", tmp);
  snprintf(out, sizeof(out), "%s/out", tmp);
  snprintf(cmd, sizeof(cmd), "rm -rf '%s' && mkdir -p '%s' '%s'", tmp, src, out);
  if(system(cmd)) return 2;

  /* Sizes that exercise the chunking: empty, tiny, exactly one chunk,
     one chunk plus a byte, and something incompressible. */
  size_t sizes[] = { 0, 11, LZC_ZSTD_CHUNK_SIZE, LZC_ZSTD_CHUNK_SIZE + 1, 700000, 300000 };
  const char *rels[] = { "empty.bin", "a.txt", "data/one.bin", "data/two.bin",
                         "data/deep/three.bin", "random.bin" };
  const size_t n_files = sizeof(sizes) / sizeof(*sizes);
  unsigned char *orig[6];
  for(size_t i = 0; i < n_files; i++) {
    orig[i] = malloc(sizes[i] ? sizes[i] : 1);
    unsigned seed = (unsigned)i * 7919u + 13u;
    for(size_t k = 0; k < sizes[i]; k++) {
      /* random.bin stays incompressible so the raw fallback is exercised. */
      seed = seed * 1103515245u + 12345u;
      orig[i][k] = (i == 5) ? (unsigned char)(seed >> 16) : (unsigned char)('a' + ((k / 97) % 26));
    }
    write_file(src, rels[i], orig[i], sizes[i]);
  }

  lzc_zstd_file_t files[6];
  for(size_t i = 0; i < n_files; i++) { files[i].rel = rels[i]; files[i].size = sizes[i]; }

  lzc_zstd_stats_t st;
  char err[512];
  int rc = lzc_zstd_pack(src, out, files, n_files, 9, NULL, &st, err, sizeof(err));
  if(rc != 0) { printf("pack failed: %s\n", err); return 1; }
  printf("packed %llu files, %llu chunks (%u zstd / %u raw), %llu -> %llu bytes in %u volume(s)\n",
         (unsigned long long)st.file_count, (unsigned long long)st.chunk_count,
         st.chunks_zstd, st.chunks_raw, (unsigned long long)st.logical_bytes,
         (unsigned long long)st.stored_bytes, st.volume_count);

  char ipath[1100];
  size_t ilen = 0;
  snprintf(ipath, sizeof(ipath), "%s/%s", out, LZC_ZSTD_INDEX_NAME);
  unsigned char *ix = slurp(ipath, &ilen);
  if(!ix) { printf("no index written\n"); return 1; }

  CHECK(memcmp(ix, "AMPRZPK1", 8) == 0, "index magic");
  CHECK(rd32(ix + 8) == 1, "index version");
  CHECK(rd32(ix + 12) == LZC_ZSTD_INDEX_HDR, "header size");
  CHECK(ix[16] == 18, "chunk_shift is 18");
  CHECK(ix[17] == 9, "level recorded");
  CHECK(rd16(ix + 18) == 0, "reserved 18 is zero");
  CHECK(rd64(ix + 104) == 0, "reserved 104 is zero");
  CHECK(rd64(ix + 120) == 0, "reserved 120 is zero");

  uint32_t vcount = rd32(ix + 20);
  uint64_t fcount = rd64(ix + 40), ccount = rd64(ix + 48);
  uint64_t foff = rd64(ix + 56), coff = rd64(ix + 64), voff = rd64(ix + 72);
  uint64_t soff = rd64(ix + 80), slen = rd64(ix + 88);
  CHECK(foff == LZC_ZSTD_INDEX_HDR, "files_off is 128");
  CHECK(coff == foff + 32 * fcount, "chunks_off follows the file records");
  CHECK(voff == coff + 8 * ccount, "volumes_off follows the chunk records");
  CHECK(soff == voff + 8 * vcount, "strings_off follows the volume records");
  CHECK(ilen == soff + slen, "the index ends at strings_off + strings_len");
  CHECK(fcount == n_files, "file count");
  CHECK(rd64(ix + 96) == st.logical_bytes, "total logical bytes");

  CHECK(rd32(ix + 112) == crc_of(ix + 128, ilen - 128), "body CRC");
  unsigned char hdr[LZC_ZSTD_INDEX_HDR];
  memcpy(hdr, ix, sizeof(hdr));
  memset(hdr + 112, 0, 8);
  CHECK(rd32(ix + 116) == crc_of(hdr, sizeof(hdr)), "header CRC");

  /* Volumes. */
  unsigned char *vol[LZC_ZSTD_MAX_VOLUMES];
  size_t vlen[LZC_ZSTD_MAX_VOLUMES];
  for(uint32_t i = 0; i < vcount; i++) {
    char vp[1200], name[32];
    snprintf(name, sizeof(name), LZC_ZSTD_VOLUME_FMT, i);
    snprintf(vp, sizeof(vp), "%s/%s", out, name);
    vol[i] = slurp(vp, &vlen[i]);
    if(!vol[i]) { printf("  FAIL missing volume %s\n", name); failures++; continue; }
    CHECK(memcmp(vol[i], "AMPRZDT1", 8) == 0, "volume %u magic", i);
    CHECK(rd32(vol[i] + 8) == 1, "volume %u version", i);
    CHECK(rd32(vol[i] + 12) == LZC_ZSTD_VOLUME_HDR, "volume %u header size", i);
    CHECK(rd32(vol[i] + 16) == i, "volume %u id", i);
    CHECK(rd32(vol[i] + 20) == vcount, "volume %u count", i);
    CHECK(memcmp(vol[i] + 24, ix + 24, 16) == 0, "volume %u archive id matches the index", i);
    CHECK(rd64(vol[i] + 40) == vlen[i] - LZC_ZSTD_VOLUME_HDR, "volume %u payload size", i);
    unsigned char vh[LZC_ZSTD_VOLUME_HDR];
    memcpy(vh, vol[i], sizeof(vh));
    memset(vh + 60, 0, 4);
    CHECK(rd32(vol[i] + 60) == crc_of(vh, sizeof(vh)), "volume %u header CRC", i);
    CHECK(rd64(ix + voff + 8 * i) == vlen[i], "volume record %u equals the file size", i);
  }

  /* File records: sorted, no duplicates, chunks decode to the source. */
  uint64_t prev_hash = 0;
  int first = 1;
  uint32_t expect_first_chunk = 0;
  for(uint64_t i = 0; i < fcount; i++) {
    const unsigned char *r = ix + foff + 32 * i;
    uint64_t hash = rd64(r), size = rd64(r + 8);
    uint32_t fc = rd32(r + 16), poff = rd32(r + 20);
    uint16_t plen = rd16(r + 24), flags = rd16(r + 26);
    CHECK(flags == 0, "record %llu has no flags", (unsigned long long)i);
    CHECK(rd32(r + 28) == 0, "record %llu reserved is zero", (unsigned long long)i);
    CHECK(first || hash >= prev_hash, "records sorted by path hash");
    first = 0; prev_hash = hash;

    char rel[1024];
    CHECK(poff + plen <= slen, "path %llu inside strings", (unsigned long long)i);
    memcpy(rel, ix + soff + poff, plen);
    rel[plen] = 0;
    CHECK(lzc_zstd_path_hash(rel, plen) == hash, "path hash of %s", rel);
    CHECK(fc == expect_first_chunk, "first_chunk of %s", rel);
    uint32_t n = (uint32_t)((size + LZC_ZSTD_CHUNK_SIZE - 1) / LZC_ZSTD_CHUNK_SIZE);
    expect_first_chunk += n;

    size_t want = 0;
    for(size_t k = 0; k < n_files; k++) if(strcmp(rels[k], rel) == 0) want = k + 1;
    CHECK(want != 0, "record names a file we packed: %s", rel);
    if(!want) continue;
    const unsigned char *source = orig[want - 1];
    CHECK(size == sizes[want - 1], "size of %s", rel);

    unsigned char *buf = malloc(LZC_ZSTD_CHUNK_SIZE);
    for(uint32_t c = 0; c < n; c++) {
      uint64_t rec = rd64(ix + coff + 8 * (fc + c));
      uint32_t off = (uint32_t)(rec & 0xFFFFFFFFULL);
      uint32_t vid = (uint32_t)((rec >> 32) & 0xFFF);
      uint32_t stored = (uint32_t)((rec >> 44) & 0x3FFFF) + 1;
      uint32_t codec = (uint32_t)(rec >> 62);
      size_t logical = size - (uint64_t)c * LZC_ZSTD_CHUNK_SIZE;
      if(logical > LZC_ZSTD_CHUNK_SIZE) logical = LZC_ZSTD_CHUNK_SIZE;
      CHECK(codec <= 1, "%s chunk %u codec is raw or zstd", rel, c);
      CHECK(off >= LZC_ZSTD_VOLUME_HDR, "%s chunk %u is past the volume header", rel, c);
      CHECK(vid < vcount, "%s chunk %u volume id", rel, c);
      if(vid >= vcount || off + stored > vlen[vid]) { failures++; printf("  FAIL %s chunk %u out of range\n", rel, c); continue; }
      if(codec == 0) {
        CHECK(stored == logical, "%s chunk %u raw size", rel, c);
        CHECK(memcmp(vol[vid] + off, source + (size_t)c * LZC_ZSTD_CHUNK_SIZE, logical) == 0,
              "%s chunk %u raw bytes", rel, c);
      } else {
        CHECK(stored < logical, "%s chunk %u zstd is smaller than raw", rel, c);
        unsigned long long framed = ZSTD_getFrameContentSize(vol[vid] + off, stored);
        CHECK(framed == logical, "%s chunk %u declares its content size", rel, c);
        size_t got = ZSTD_decompress(buf, LZC_ZSTD_CHUNK_SIZE, vol[vid] + off, stored);
        CHECK(!ZSTD_isError(got) && got == logical, "%s chunk %u decodes", rel, c);
        if(!ZSTD_isError(got) && got == logical) {
          CHECK(memcmp(buf, source + (size_t)c * LZC_ZSTD_CHUNK_SIZE, logical) == 0,
                "%s chunk %u round-trips", rel, c);
        }
      }
    }
    free(buf);
  }
  CHECK(expect_first_chunk == ccount, "chunk records all belong to a file");
  CHECK(lzc_zstd_probe(out) == 1, "probe recognises the archive");

  for(uint32_t i = 0; i < vcount; i++) free(vol[i]);
  for(size_t i = 0; i < n_files; i++) free(orig[i]);
  free(ix);
  if(failures) printf("\n%d check(s) FAILED\n", failures);
  else printf("\nall checks passed\n");
  fflush(stdout);
  return failures ? 1 : 0;
}
