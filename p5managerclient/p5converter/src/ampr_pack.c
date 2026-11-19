/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - AMPR seekable LZ4 asset packs.
 *
 * C port of drakmor's ampr_pack.py "pack", "verify --root", "unpack" and
 * "remove-packed-sources" for AMPRPAK4 manifests and AMPRDAT3 volumes.
 * See ampr_pack.h.
 */

#include "ampr_pack.h"
#include "ampr_pack_internal.h"
#include "ampr_index.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "lz4.h"
#include "lz4hc.h"
#include "zlib.h"

/* ------------------------------------------------------------ format */

#define INDEX_MAGIC "AMPRPAK4"
#define DATA_MAGIC "AMPRDAT3"
#define CRC_MAGIC "AMPRCRC1"
#define CFG_MAGIC "AMPRCFG1"
#define INDEX_VERSION 4u
#define DATA_VERSION 3u
#define CRC_VERSION 1u
#define ENDIAN_MARKER 0x01020304u
#define INDEX_HEADER_SIZE 128u
#define DATA_HEADER_SIZE 64u
#define CRC_HEADER_SIZE 48u
#define RUNTIME_PROFILE_SIZE 64u
#define FILE_RECORD_SIZE 48u
#define CHUNK_RECORD_SIZE 12u
#define PACK_RECORD_SIZE 32u

#define FILE_FLAG_PACKED        (1u << 0)
#define FILE_FLAG_STORE_ONLY    (1u << 1)
#define FILE_FLAG_STREAMING     (1u << 2)
#define FILE_FLAG_HOT           (1u << 3)
#define FILE_FLAG_RANDOM_ACCESS (1u << 4)
#define FILE_KNOWN_FLAGS 0x1Fu

#define CHUNK_CODEC_RAW 0u
#define CHUNK_CODEC_LZ4 1u
#define CHUNK_FLAG_SHARED         (1u << 0)
#define CHUNK_FLAG_STREAMING      (1u << 1)
#define CHUNK_FLAG_PAGE_CONTAINED (1u << 2)
#define CHUNK_FLAG_PAGE_ALIGNED   (1u << 3)
#define CHUNK_KNOWN_FLAGS 0x0Fu

#define PACK_FLAG_STRIPED        (1u << 0)
#define PACK_FLAG_IO_PAGE_LAYOUT (1u << 1)
#define PACK_KNOWN_FLAGS 0x03u

#define CHUNK_OFFSET_MASK ((1ULL << 48) - 1)
#define CHUNK_STORED_MASK 0xFFFFFu

/* Runtime limits documented for the packed ampr_emu build. */
#define RUNTIME_MAX_FILES 2000000ULL
#define RUNTIME_MAX_CHUNKS 16000000ULL
#define RUNTIME_MAX_PACKS 1024u
#define RUNTIME_POOL_BYTES (384ULL * 1024 * 1024)

#define AP_IO_BUFFER (4u * 1024u * 1024u)
#define AP_WINDOW_BYTES (4u * 1024u * 1024u)
#define MIB (1024ULL * 1024ULL)

/* ----------------------------------------------------------- helpers */

static void
ap_err(char *err, size_t err_size, const char *fmt, ...) {
  if(!err || !err_size || err[0]) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(err, err_size, fmt, ap);
  va_end(ap);
}

static void
put_le32(unsigned char *p, uint32_t v) {
  for(int i = 0; i < 4; i++) p[i] = (unsigned char)(v >> (8 * i));
}

static void
put_le64(unsigned char *p, uint64_t v) {
  for(int i = 0; i < 8; i++) p[i] = (unsigned char)(v >> (8 * i));
}

static uint16_t
get_le16(const unsigned char *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}

static uint32_t
get_le32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

static uint64_t
get_le64(const unsigned char *p) {
  return (uint64_t)get_le32(p) | ((uint64_t)get_le32(p + 4) << 32);
}

static uint64_t
align_up(uint64_t v, uint64_t a) {
  return (v + a - 1) & ~(a - 1);
}

static uint64_t
align_down(uint64_t v, uint64_t a) {
  return v & ~(a - 1);
}

static uint32_t
crc32_buf(uint32_t crc, const void *data, size_t len) {
  const unsigned char *p = data;
  uLong c = crc;
  while(len) {
    uInt n = len > 0x40000000u ? 0x40000000u : (uInt)len;
    c = crc32(c, p, n);
    p += n;
    len -= n;
  }
  return (uint32_t)c;
}

static int
ascii_tolower(int c) {
  return c >= 'A' && c <= 'Z' ? c + 32 : c;
}

static uint64_t
fnv1a64_folded(const char *s) {
  uint64_t h = 0xCBF29CE484222325ULL;
  for(const unsigned char *p = (const unsigned char *)s; *p; p++) {
    h ^= (uint64_t)ascii_tolower(*p);
    h *= 0x100000001B3ULL;
  }
  return h ? h : 1;
}

static int
ascii_casecmp(const char *a, const char *b) {
  const unsigned char *pa = (const unsigned char *)a;
  const unsigned char *pb = (const unsigned char *)b;
  while(*pa || *pb) {
    int ca = ascii_tolower(*pa);
    int cb = ascii_tolower(*pb);
    if(ca != cb) return ca - cb;
    if(*pa) pa++;
    if(*pb) pb++;
  }
  return 0;
}

static int
join2(char *out, size_t out_size, const char *a, const char *b) {
  int n = snprintf(out, out_size, "%s/%s", a, b);
  if(n < 0 || (size_t)n >= out_size) {
    errno = ENAMETOOLONG;
    return -1;
  }
  return 0;
}

static int
mkdirs_p(const char *path, mode_t mode) {
  char tmp[1024];
  struct stat st;
  if(snprintf(tmp, sizeof(tmp), "%s", path) >= (int)sizeof(tmp)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  size_t len = strlen(tmp);
  while(len > 1 && tmp[len - 1] == '/') tmp[--len] = 0;
  for(char *p = tmp + 1; *p; p++) {
    if(*p != '/') continue;
    *p = 0;
    if(stat(tmp, &st) != 0) {
      if(mkdir(tmp, mode) != 0 && errno != EEXIST) return -1;
      (void)chmod(tmp, mode);
    }
    *p = '/';
  }
  if(stat(tmp, &st) == 0) return S_ISDIR(st.st_mode) ? 0 : (errno = ENOTDIR, -1);
  if(mkdir(tmp, mode) != 0 && errno != EEXIST) return -1;
  (void)chmod(tmp, mode);
  return 0;
}

static int
mkdirs_parent(const char *path) {
  char parent[1024];
  snprintf(parent, sizeof(parent), "%s", path);
  char *slash = strrchr(parent, '/');
  if(!slash || slash == parent) return 0;
  *slash = 0;
  return mkdirs_p(parent, 0777);
}

static int
write_all(int fd, const void *data, size_t len) {
  const unsigned char *p = data;
  while(len) {
    ssize_t n = write(fd, p, len);
    if(n < 0) {
      if(errno == EINTR) continue;
      return -1;
    }
    if(n == 0) {
      errno = EIO;
      return -1;
    }
    p += n;
    len -= (size_t)n;
  }
  return 0;
}

static int
pwrite_all(int fd, const void *data, size_t len, uint64_t off) {
  const unsigned char *p = data;
  while(len) {
    ssize_t n = pwrite(fd, p, len, (off_t)off);
    if(n < 0) {
      if(errno == EINTR) continue;
      return -1;
    }
    if(n == 0) {
      errno = EIO;
      return -1;
    }
    p += n;
    len -= (size_t)n;
    off += (uint64_t)n;
  }
  return 0;
}

static ssize_t
read_full(int fd, void *data, size_t len) {
  unsigned char *p = data;
  size_t done = 0;
  while(done < len) {
    ssize_t n = read(fd, p + done, len - done);
    if(n < 0) {
      if(errno == EINTR) continue;
      return -1;
    }
    if(n == 0) break;
    done += (size_t)n;
  }
  return (ssize_t)done;
}

static ssize_t
pread_full(int fd, void *data, size_t len, uint64_t off) {
  unsigned char *p = data;
  size_t done = 0;
  while(done < len) {
    ssize_t n = pread(fd, p + done, len - done, (off_t)(off + done));
    if(n < 0) {
      if(errno == EINTR) continue;
      return -1;
    }
    if(n == 0) break;
    done += (size_t)n;
  }
  return (ssize_t)done;
}

static int
read_file_alloc(const char *path, unsigned char **out, size_t *out_size,
                size_t max_size) {
  struct stat st;
  int fd = open(path, O_RDONLY);
  if(fd < 0) return -1;
  if(fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ||
     (uint64_t)st.st_size > max_size) {
    close(fd);
    errno = EINVAL;
    return -1;
  }
  size_t size = (size_t)st.st_size;
  unsigned char *buf = malloc(size ? size : 1);
  if(!buf) {
    close(fd);
    errno = ENOMEM;
    return -1;
  }
  if(read_full(fd, buf, size) != (ssize_t)size) {
    free(buf);
    close(fd);
    errno = EIO;
    return -1;
  }
  close(fd);
  *out = buf;
  *out_size = size;
  return 0;
}

/* Writes data to path atomically (temp + fsync + rename). */
static int
write_file_atomic(const char *path, const void *data, size_t size,
                  mode_t mode) {
  char tmp[1100];
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", path);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, mode);
  if(fd < 0) return -1;
  (void)fchmod(fd, mode);
  if(write_all(fd, data, size) != 0 || fsync(fd) != 0) {
    int e = errno;
    close(fd);
    unlink(tmp);
    errno = e;
    return -1;
  }
  if(close(fd) != 0 || rename(tmp, path) != 0) {
    int e = errno;
    unlink(tmp);
    errno = e;
    return -1;
  }
  return 0;
}

/* ----------------------------------------------------------- SHA-256 */

typedef struct ap_sha256 {
  uint32_t h[8];
  uint64_t len;
  unsigned char buf[64];
  size_t n;
} ap_sha256_t;

static const uint32_t k_sha_k[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

#define ROR32(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void
sha256_block(ap_sha256_t *s, const unsigned char *p) {
  uint32_t w[64];
  for(int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)p[i * 4] << 24) | ((uint32_t)p[i * 4 + 1] << 16) |
           ((uint32_t)p[i * 4 + 2] << 8) | (uint32_t)p[i * 4 + 3];
  }
  for(int i = 16; i < 64; i++) {
    uint32_t s0 = ROR32(w[i - 15], 7) ^ ROR32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = ROR32(w[i - 2], 17) ^ ROR32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = s->h[0], b = s->h[1], c = s->h[2], d = s->h[3];
  uint32_t e = s->h[4], f = s->h[5], g = s->h[6], h = s->h[7];
  for(int i = 0; i < 64; i++) {
    uint32_t S1 = ROR32(e, 6) ^ ROR32(e, 11) ^ ROR32(e, 25);
    uint32_t ch = (e & f) ^ (~e & g);
    uint32_t t1 = h + S1 + ch + k_sha_k[i] + w[i];
    uint32_t S0 = ROR32(a, 2) ^ ROR32(a, 13) ^ ROR32(a, 22);
    uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + mj;
    h = g; g = f; f = e; e = d + t1;
    d = c; c = b; b = a; a = t1 + t2;
  }
  s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d;
  s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void
sha256_init(ap_sha256_t *s) {
  static const uint32_t iv[8] = {
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  };
  memcpy(s->h, iv, sizeof(iv));
  s->len = 0;
  s->n = 0;
}

static void
sha256_update(ap_sha256_t *s, const void *data, size_t len) {
  const unsigned char *p = data;
  s->len += len;
  while(len) {
    size_t take = 64 - s->n;
    if(take > len) take = len;
    memcpy(s->buf + s->n, p, take);
    s->n += take;
    p += take;
    len -= take;
    if(s->n == 64) {
      sha256_block(s, s->buf);
      s->n = 0;
    }
  }
}

static void
sha256_final(ap_sha256_t *s, unsigned char out[32]) {
  uint64_t bits = s->len * 8;
  unsigned char pad = 0x80;
  sha256_update(s, &pad, 1);
  unsigned char zero = 0;
  while(s->n != 56) sha256_update(s, &zero, 1);
  unsigned char lenb[8];
  for(int i = 0; i < 8; i++) lenb[i] = (unsigned char)(bits >> (56 - 8 * i));
  sha256_update(s, lenb, 8);
  for(int i = 0; i < 8; i++) {
    out[i * 4] = (unsigned char)(s->h[i] >> 24);
    out[i * 4 + 1] = (unsigned char)(s->h[i] >> 16);
    out[i * 4 + 2] = (unsigned char)(s->h[i] >> 8);
    out[i * 4 + 3] = (unsigned char)s->h[i];
  }
}

/* ------------------------------------------------------------- XXH64 */

#define XP1 11400714785074694791ULL
#define XP2 14029467366897019727ULL
#define XP3 1609587929392839161ULL
#define XP4 9650029242287828579ULL
#define XP5 2870177450012600261ULL

static uint64_t
rotl64(uint64_t x, int r) {
  return (x << r) | (x >> (64 - r));
}

static uint64_t
xxh_round(uint64_t acc, uint64_t in) {
  acc += in * XP2;
  acc = rotl64(acc, 31);
  return acc * XP1;
}

static uint64_t
xxh_merge(uint64_t acc, uint64_t v) {
  acc ^= xxh_round(0, v);
  return acc * XP1 + XP4;
}

static uint64_t
xxh64(const void *data, size_t len, uint64_t seed) {
  const unsigned char *p = data;
  const unsigned char *end = p + len;
  uint64_t h;
  if(len >= 32) {
    uint64_t v1 = seed + XP1 + XP2, v2 = seed + XP2, v3 = seed, v4 = seed - XP1;
    const unsigned char *limit = end - 32;
    do {
      uint64_t a, b, c, d;
      memcpy(&a, p, 8);
      memcpy(&b, p + 8, 8);
      memcpy(&c, p + 16, 8);
      memcpy(&d, p + 24, 8);
      v1 = xxh_round(v1, a);
      v2 = xxh_round(v2, b);
      v3 = xxh_round(v3, c);
      v4 = xxh_round(v4, d);
      p += 32;
    } while(p <= limit);
    h = rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18);
    h = xxh_merge(h, v1);
    h = xxh_merge(h, v2);
    h = xxh_merge(h, v3);
    h = xxh_merge(h, v4);
  } else {
    h = seed + XP5;
  }
  h += (uint64_t)len;
  while(p + 8 <= end) {
    uint64_t k;
    memcpy(&k, p, 8);
    h ^= xxh_round(0, k);
    h = rotl64(h, 27) * XP1 + XP4;
    p += 8;
  }
  if(p + 4 <= end) {
    uint32_t k;
    memcpy(&k, p, 4);
    h ^= (uint64_t)k * XP1;
    h = rotl64(h, 23) * XP2 + XP3;
    p += 4;
  }
  while(p < end) {
    h ^= (*p) * XP5;
    h = rotl64(h, 11) * XP1;
    p++;
  }
  h ^= h >> 33;
  h *= XP2;
  h ^= h >> 29;
  h *= XP3;
  h ^= h >> 32;
  return h;
}

/* --------------------------------------------------------- callbacks */

typedef struct ap_cb {
  const ampr_pack_callbacks_t *cb;
  uint64_t last_progress_ms;
} ap_cb_t;

static uint64_t
now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
}

static void
cb_phase(ap_cb_t *c, const char *id, const char *label) {
  if(c->cb && c->cb->phase) c->cb->phase(c->cb->ctx, id, label);
  c->last_progress_ms = 0;
}

static void
cb_progress(ap_cb_t *c, uint64_t done, uint64_t total, int force) {
  if(!c->cb || !c->cb->progress) return;
  uint64_t t = now_ms();
  if(!force && t - c->last_progress_ms < 200) return;
  c->last_progress_ms = t;
  c->cb->progress(c->cb->ctx, done, total);
}

static void
cb_current(ap_cb_t *c, const char *rel) {
  if(c->cb && c->cb->current) c->cb->current(c->cb->ctx, rel);
}

static int
cb_cancelled(ap_cb_t *c) {
  return c->cb && c->cb->cancelled && c->cb->cancelled(c->cb->ctx);
}

static void
cb_log(ap_cb_t *c, const char *fmt, ...) {
  if(!c->cb || !c->cb->log) return;
  char msg[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof(msg), fmt, ap);
  va_end(ap);
  c->cb->log(c->cb->ctx, msg);
}

/* -------------------------------------------------------------- scan */

static int
scan_add_file(ap_scan_t *s, const char *rel, const struct stat *st) {
  if(s->file_count == s->file_cap) {
    size_t next = s->file_cap ? s->file_cap * 2 : 1024;
    ap_scan_file_t *f = realloc(s->files, next * sizeof(*f));
    if(!f) return -1;
    s->files = f;
    s->file_cap = next;
  }
  ap_scan_file_t *f = &s->files[s->file_count];
  f->rel = strdup(rel);
  if(!f->rel) return -1;
  f->size = (uint64_t)st->st_size;
  f->mtime = (int64_t)st->st_mtime;
  f->mode = (uint32_t)st->st_mode;
  s->file_count++;
  s->total_bytes += f->size;
  return 0;
}

static void
scan_free(ap_scan_t *s) {
  for(size_t i = 0; i < s->file_count; i++) free(s->files[i].rel);
  free(s->files);
  ap_strlist_free(&s->dirs);
  memset(s, 0, sizeof(*s));
}

static int
scan_walk(const char *root, const char *rel, ap_scan_t *s, ap_cb_t *cb,
          char *err, size_t err_size) {
  char path[1024];
  if(rel[0]) {
    if(join2(path, sizeof(path), root, rel) != 0) {
      ap_err(err, err_size, "path too long: %s", rel);
      return -1;
    }
  } else {
    snprintf(path, sizeof(path), "%s", root);
  }
  DIR *d = opendir(path);
  if(!d) {
    ap_err(err, err_size, "open folder %s: %s", rel[0] ? rel : "/",
           strerror(errno));
    return -1;
  }
  struct dirent *ent;
  int rc = 0;
  while(rc == 0 && (ent = readdir(d)) != NULL) {
    char child_rel[1024];
    char child[1024];
    struct stat st;
    if(!strcmp(ent->d_name, ".") || !strcmp(ent->d_name, "..")) continue;
    if(cb_cancelled(cb)) {
      ap_err(err, err_size, "cancelled");
      rc = -1;
      break;
    }
    int n = rel[0] ? snprintf(child_rel, sizeof(child_rel), "%s/%s", rel, ent->d_name)
                   : snprintf(child_rel, sizeof(child_rel), "%s", ent->d_name);
    if(n < 0 || (size_t)n >= sizeof(child_rel) - 8 ||
       join2(child, sizeof(child), root, child_rel) != 0) {
      ap_err(err, err_size, "path too long: %s", ent->d_name);
      rc = -1;
      break;
    }
    if(lstat(child, &st) != 0) {
      ap_err(err, err_size, "stat %s: %s", child_rel, strerror(errno));
      rc = -1;
      break;
    }
    if(S_ISDIR(st.st_mode)) {
      if(ap_strlist_add(&s->dirs, child_rel) != 0) {
        ap_err(err, err_size, "out of memory");
        rc = -1;
        break;
      }
      rc = scan_walk(root, child_rel, s, cb, err, err_size);
    } else if(S_ISREG(st.st_mode)) {
      if(scan_add_file(s, child_rel, &st) != 0) {
        ap_err(err, err_size, "out of memory");
        rc = -1;
      }
    }
  }
  closedir(d);
  return rc;
}

static ap_scan_file_t *
scan_find_ci(ap_scan_t *s, const char *rel) {
  for(size_t i = 0; i < s->file_count; i++) {
    if(!ascii_casecmp(s->files[i].rel, rel)) return &s->files[i];
  }
  return NULL;
}

/* Root files that never go into ampr_emu.index. */
static int
index_excluded_rel(const char *rel) {
  return !ascii_casecmp(rel, "ampr_emu.index") ||
         !ascii_casecmp(rel, "ampr_emu.index.tmp") ||
         !ascii_casecmp(rel, "ampr_commands.bin") ||
         !ascii_casecmp(rel, "apr_emu.log");
}

/* -------------------------------------------------------------- items */

typedef struct ap_item {
  const char *rel;          /* points into idx_paths, after "/app0/" */
  const char *app0;         /* "/app0/<rel>" */
  uint32_t path_len;
  uint32_t path_offset;
  uint64_t path_hash;
  uint64_t size;
  int64_t idx_mtime;
  int64_t mtime;
  const ap_rule_t *rule;
  ap_rule_t own_rule;
  int action;
  uint32_t lane;
  uint32_t first_chunk;
  uint32_t chunk_count;
} ap_item_t;

/* ------------------------------------------------------------ worker */

typedef struct ap_slot {
  unsigned char *raw;
  unsigned char *out;
  uint32_t raw_cap;
  uint32_t out_cap;
  uint32_t raw_len;
  uint32_t item;
  uint32_t block;
  /* parameters */
  int store;
  int mode_hc;
  int level;
  int accel;
  int streaming;
  uint64_t min_bytes;
  double min_ratio;
  uint64_t neutral_bytes;
  double neutral_ratio;
  uint32_t io_page;
  int want_hash;
  /* results */
  int codec;
  uint32_t stored_len;
  uint32_t raw_crc;
  uint64_t h1;
  uint64_t h2;
  int state; /* 0 idle, 1 queued, 2 done */
} ap_slot_t;

typedef struct ap_pool {
  pthread_t *threads;
  int nthreads;
  int started;
  pthread_mutex_t mu;
  pthread_cond_t cv_work;
  pthread_cond_t cv_done;
  ap_slot_t **queue;
  size_t qcap;
  size_t qhead;
  size_t qcount;
  int stop;
} ap_pool_t;

static void
slot_process(ap_slot_t *s, void *hc_state, void *fast_state) {
  s->raw_crc = crc32_buf(0, s->raw, s->raw_len);
  if(s->want_hash) {
    s->h1 = xxh64(s->raw, s->raw_len, 0x9E3779B97F4A7C15ULL ^ s->raw_len);
    s->h2 = xxh64(s->raw, s->raw_len,
                  ((uint64_t)s->raw_crc << 32) ^ 0xC2B2AE3D27D4EB4FULL);
  }
  s->codec = CHUNK_CODEC_RAW;
  s->stored_len = s->raw_len;
  if(s->store) return;
  int n;
  if(s->mode_hc) {
    int level = s->level < 1 ? 1 : (s->level > 12 ? 12 : s->level);
    n = LZ4_compress_HC_extStateHC(hc_state, (const char *)s->raw,
                                   (char *)s->out, (int)s->raw_len,
                                   (int)s->out_cap, level);
  } else {
    n = LZ4_compress_fast_extState(fast_state, (const char *)s->raw,
                                   (char *)s->out, (int)s->raw_len,
                                   (int)s->out_cap,
                                   s->accel < 1 ? 1 : s->accel);
  }
  if(n <= 0) return;
  int64_t saved = (int64_t)s->raw_len - (int64_t)n;
  double ratio = (double)saved / (double)s->raw_len;
  uint64_t req_bytes = s->min_bytes;
  double req_ratio = s->min_ratio;
  if(!s->streaming) {
    uint64_t raw_pages = (s->raw_len + s->io_page - 1) / s->io_page;
    uint64_t comp_pages = ((uint64_t)n + s->io_page - 1) / s->io_page;
    if(comp_pages >= raw_pages) {
      if(s->neutral_bytes > req_bytes) req_bytes = s->neutral_bytes;
      if(s->neutral_ratio > req_ratio) req_ratio = s->neutral_ratio;
    }
  }
  if(saved < (int64_t)req_bytes || ratio < req_ratio) return;
  s->codec = CHUNK_CODEC_LZ4;
  s->stored_len = (uint32_t)n;
}

static void *
pool_thread(void *arg) {
  ap_pool_t *p = arg;
  void *hc = malloc((size_t)LZ4_sizeofStateHC());
  void *fast = malloc((size_t)LZ4_sizeofState());
  for(;;) {
    pthread_mutex_lock(&p->mu);
    while(!p->stop && p->qcount == 0) pthread_cond_wait(&p->cv_work, &p->mu);
    if(p->qcount == 0 && p->stop) {
      pthread_mutex_unlock(&p->mu);
      break;
    }
    ap_slot_t *s = p->queue[p->qhead];
    p->qhead = (p->qhead + 1) % p->qcap;
    p->qcount--;
    pthread_mutex_unlock(&p->mu);
    if(hc && fast) {
      slot_process(s, hc, fast);
    } else {
      /* Out of memory for LZ4 state: store the block RAW. */
      s->raw_crc = crc32_buf(0, s->raw, s->raw_len);
      if(s->want_hash) {
        s->h1 = xxh64(s->raw, s->raw_len, 0x9E3779B97F4A7C15ULL ^ s->raw_len);
        s->h2 = xxh64(s->raw, s->raw_len,
                      ((uint64_t)s->raw_crc << 32) ^ 0xC2B2AE3D27D4EB4FULL);
      }
      s->codec = CHUNK_CODEC_RAW;
      s->stored_len = s->raw_len;
    }
    pthread_mutex_lock(&p->mu);
    s->state = 2;
    pthread_cond_broadcast(&p->cv_done);
    pthread_mutex_unlock(&p->mu);
  }
  free(hc);
  free(fast);
  return NULL;
}

static int
pool_start(ap_pool_t *p, int nthreads, size_t qcap) {
  memset(p, 0, sizeof(*p));
  p->queue = calloc(qcap, sizeof(*p->queue));
  p->threads = calloc((size_t)nthreads, sizeof(*p->threads));
  if(!p->queue || !p->threads) {
    free(p->queue);
    free(p->threads);
    return -1;
  }
  p->qcap = qcap;
  pthread_mutex_init(&p->mu, NULL);
  pthread_cond_init(&p->cv_work, NULL);
  pthread_cond_init(&p->cv_done, NULL);
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, 512 * 1024);
  for(int i = 0; i < nthreads; i++) {
    if(pthread_create(&p->threads[i], &attr, pool_thread, p) != 0) break;
    p->nthreads++;
  }
  pthread_attr_destroy(&attr);
  p->started = 1;
  if(p->nthreads == 0) return -1;
  return 0;
}

static void
pool_stop(ap_pool_t *p) {
  if(!p->started) return;
  pthread_mutex_lock(&p->mu);
  p->stop = 1;
  pthread_cond_broadcast(&p->cv_work);
  pthread_mutex_unlock(&p->mu);
  for(int i = 0; i < p->nthreads; i++) pthread_join(p->threads[i], NULL);
  pthread_mutex_destroy(&p->mu);
  pthread_cond_destroy(&p->cv_work);
  pthread_cond_destroy(&p->cv_done);
  free(p->queue);
  free(p->threads);
  memset(p, 0, sizeof(*p));
}

static void
pool_submit(ap_pool_t *p, ap_slot_t *s) {
  pthread_mutex_lock(&p->mu);
  s->state = 1;
  p->queue[(p->qhead + p->qcount) % p->qcap] = s;
  p->qcount++;
  pthread_cond_signal(&p->cv_work);
  pthread_mutex_unlock(&p->mu);
}

static void
pool_wait(ap_pool_t *p, ap_slot_t *s) {
  pthread_mutex_lock(&p->mu);
  while(s->state != 2) pthread_cond_wait(&p->cv_done, &p->mu);
  pthread_mutex_unlock(&p->mu);
}

static void
slot_set_rule(ap_slot_t *s, const ap_rule_t *r, int action, uint32_t io_page,
              int want_hash) {
  s->store = action == AP_ACTION_STORE;
  s->mode_hc = r->mode_hc;
  s->level = r->level;
  s->accel = r->acceleration;
  s->streaming = ap_rule_resolved_layout(r) == AP_LAYOUT_STREAMING;
  s->min_bytes = r->min_savings_bytes;
  s->min_ratio = r->min_savings_ratio;
  s->neutral_bytes = r->io_neutral_min_savings_bytes;
  s->neutral_ratio = r->io_neutral_min_savings_ratio;
  s->io_page = io_page;
  s->want_hash = want_hash;
}

/* ------------------------------------------------------------ writer */

typedef struct ap_writer {
  uint32_t pack_id;
  int group;
  uint32_t lane;
  uint32_t volume;
  char name[512];
  char final_path[1024];
  char temp_path[1100];
  int fd;
  uint64_t position;
  uint64_t payload_offset;
  uint32_t io_page;
  uint32_t chunk_align;
  uint64_t max_pack_size;
  uint32_t flags;
  unsigned char *buf;
  size_t buf_len;
  uint64_t padding;
  uint64_t final_size;
  int finalized;
  int published;
} ap_writer_t;

static int
writer_flush(ap_writer_t *w) {
  if(!w->buf_len) return 0;
  if(write_all(w->fd, w->buf, w->buf_len) != 0) return -1;
  w->buf_len = 0;
  return 0;
}

static int
writer_put(ap_writer_t *w, const void *data, size_t len) {
  const unsigned char *p = data;
  while(len) {
    if(w->buf_len == AP_IO_BUFFER && writer_flush(w) != 0) return -1;
    size_t take = AP_IO_BUFFER - w->buf_len;
    if(take > len) take = len;
    if(p) memcpy(w->buf + w->buf_len, p, take);
    else memset(w->buf + w->buf_len, 0, take);
    w->buf_len += take;
    if(p) p += take;
    len -= take;
  }
  return 0;
}

static void
writer_placement(const ap_writer_t *w, uint32_t stored, int streaming,
                 int extent_start, uint64_t *off_out, uint32_t *flags_out) {
  uint64_t pos = w->position;
  uint64_t off;
  if(extent_start) pos = align_up(pos, w->io_page);
  if(streaming) {
    off = align_up(pos, w->chunk_align);
  } else if(stored >= w->io_page) {
    off = align_up(pos, w->io_page);
  } else {
    off = align_up(pos, w->chunk_align);
    uint64_t page_end = align_up(off + 1, w->io_page);
    if(off + stored > page_end) off = align_up(off, w->io_page);
  }
  uint32_t flags = 0;
  if(stored <= w->io_page &&
     off / w->io_page == (off + stored - 1) / w->io_page) {
    flags |= CHUNK_FLAG_PAGE_CONTAINED;
  }
  if(off % w->io_page == 0) flags |= CHUNK_FLAG_PAGE_ALIGNED;
  *off_out = off;
  *flags_out = flags;
}

static int
writer_can_fit(const ap_writer_t *w, uint32_t stored, int streaming,
               int extent_start) {
  uint64_t off;
  uint32_t flags;
  writer_placement(w, stored, streaming, extent_start, &off, &flags);
  uint64_t projected = align_up(off + stored, w->io_page);
  return w->max_pack_size == 0 || projected <= w->max_pack_size;
}

static int
writer_write(ap_writer_t *w, const void *data, uint32_t len, int streaming,
             int extent_start, uint64_t *off_out, uint32_t *flags_out) {
  uint64_t off;
  uint32_t flags;
  writer_placement(w, len, streaming, extent_start, &off, &flags);
  uint64_t padding = off - w->position;
  if(padding) {
    if(writer_put(w, NULL, (size_t)padding) != 0) return -1;
    w->padding += padding;
  }
  if(writer_put(w, data, len) != 0) return -1;
  w->position = off + len;
  *off_out = off;
  *flags_out = flags;
  return 0;
}

static void
writer_abort(ap_writer_t *w) {
  if(w->fd >= 0) close(w->fd);
  w->fd = -1;
  free(w->buf);
  w->buf = NULL;
  if(!w->published) unlink(w->temp_path);
}

/* ---------------------------------------------------------- dedupe */

typedef struct ap_dd_entry {
  uint64_t h1;
  uint64_t h2;
  uint32_t tag;
  uint32_t chunk_plus1;
} ap_dd_entry_t;

typedef struct ap_dedupe {
  ap_dd_entry_t *slots;
  size_t mask;
  size_t count;
  size_t limit;
} ap_dedupe_t;

static int
dedupe_init(ap_dedupe_t *d, uint64_t expected) {
  size_t cap = 1024;
  uint64_t want = expected + expected / 3 + 16;
  while(cap < want && cap < ((size_t)1 << 30)) cap <<= 1;
  d->slots = calloc(cap, sizeof(*d->slots));
  if(!d->slots) return -1;
  d->mask = cap - 1;
  d->count = 0;
  d->limit = cap - cap / 4;
  return 0;
}

static int64_t
dedupe_find(const ap_dedupe_t *d, uint64_t h1, uint64_t h2, uint32_t tag) {
  if(!d->slots) return -1;
  size_t pos = (size_t)(h1 ^ (h2 >> 7) ^ ((uint64_t)tag * XP3)) & d->mask;
  for(;;) {
    const ap_dd_entry_t *e = &d->slots[pos];
    if(!e->chunk_plus1) return -1;
    if(e->h1 == h1 && e->h2 == h2 && e->tag == tag) return e->chunk_plus1 - 1;
    pos = (pos + 1) & d->mask;
  }
}

static void
dedupe_insert(ap_dedupe_t *d, uint64_t h1, uint64_t h2, uint32_t tag,
              uint32_t chunk) {
  if(!d->slots || d->count >= d->limit) return;
  size_t pos = (size_t)(h1 ^ (h2 >> 7) ^ ((uint64_t)tag * XP3)) & d->mask;
  while(d->slots[pos].chunk_plus1) pos = (pos + 1) & d->mask;
  d->slots[pos].h1 = h1;
  d->slots[pos].h2 = h2;
  d->slots[pos].tag = tag;
  d->slots[pos].chunk_plus1 = chunk + 1;
  d->count++;
}

/* ------------------------------------------------------------ context */

typedef struct ap_ctx {
  const ampr_pack_options_t *o;
  ampr_pack_stats_t *st;
  char *err;
  size_t err_size;
  ap_cb_t cb;

  const char *src;
  const char *out;
  int in_place;

  ap_config_t cfg;
  ap_scan_t scan;

  unsigned char *idx;
  size_t idx_size;
  ap_item_t *items;
  size_t item_count;
  uint64_t strings_size;

  uint64_t *chunk_loc;
  uint32_t *chunk_desc;
  uint32_t *chunk_crc;
  uint64_t chunk_total;

  ap_writer_t **writers;
  size_t writer_count;
  size_t writer_cap;
  int32_t **current;
  uint32_t **volume_numbers;

  ap_dedupe_t dd;
  ap_pool_t pool;
  ap_slot_t *slots;
  size_t slot_count;

  unsigned char build_id[16];
  int published;
  char index_path[1024];
  char crc_path[1100];
  char runtime_path[1100];

  /* in-place rollback state */
  unsigned char *backup_index;
  size_t backup_index_size;
  int had_index;
  unsigned char *backup_runtime;
  size_t backup_runtime_size;
  char runtime_rel[512];
  int runtime_replaced;
  int runtime_created;
  int index_written;
} ap_ctx_t;

static void
ctx_err(ap_ctx_t *c, const char *fmt, ...) {
  if(!c->err || !c->err_size || c->err[0]) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(c->err, c->err_size, fmt, ap);
  va_end(ap);
}

static int
ctx_check_cancel(ap_ctx_t *c) {
  if(cb_cancelled(&c->cb)) {
    ctx_err(c, "cancelled");
    errno = ECANCELED;
    return -1;
  }
  return 0;
}

static uint32_t
group_io_page(const ap_ctx_t *c, int group) {
  uint32_t p = c->cfg.groups[group].io_page_size;
  return p ? p : c->cfg.io_page_size;
}

/* ------------------------------------------------- index (AMPRIDX3) */

static int
build_index(ap_ctx_t *c) {
  ampr_index_entry_t *entries = calloc(c->scan.file_count ? c->scan.file_count : 1,
                                       sizeof(*entries));
  ampr_index_stats_t istats;
  size_t n = 0;
  if(!entries) {
    ctx_err(c, "out of memory");
    return -1;
  }
  for(size_t i = 0; i < c->scan.file_count; i++) {
    const ap_scan_file_t *f = &c->scan.files[i];
    if(!strchr(f->rel, '/') && index_excluded_rel(f->rel)) continue;
    entries[n].rel = f->rel;
    entries[n].size = f->size;
    entries[n].mtime = f->mtime;
    n++;
  }
  if(n == 0) {
    free(entries);
    ctx_err(c, "game folder has no files");
    return -1;
  }
  int rc = ampr_index_build_to_memory(entries, n, 0, &c->idx, &c->idx_size,
                                      &istats, c->err, c->err_size);
  free(entries);
  if(rc != 0) {
    ctx_err(c, "could not build ampr_emu.index");
    return -1;
  }
  /* Parse back exactly what the runtime will read: fileId = record + 1. */
  if(c->idx_size < 48 || memcmp(c->idx, "AMPRIDX3", 8) ||
     get_le32(c->idx + 8) != 3 || get_le32(c->idx + 12) != 24) {
    ctx_err(c, "generated AMPR index is invalid");
    return -1;
  }
  uint64_t count = get_le64(c->idx + 16);
  uint64_t path_bytes = get_le64(c->idx + 24);
  uint64_t paths_off = 48 + count * 24;
  if(count == 0 || count > RUNTIME_MAX_FILES || paths_off + path_bytes > c->idx_size) {
    ctx_err(c, count > RUNTIME_MAX_FILES ?
            "too many files for the LZ4 runtime (limit 2,000,000)" :
            "generated AMPR index is invalid");
    return -1;
  }
  c->items = calloc((size_t)count, sizeof(*c->items));
  if(!c->items) {
    ctx_err(c, "out of memory");
    return -1;
  }
  c->item_count = (size_t)count;
  uint64_t strings = 0;
  for(size_t i = 0; i < c->item_count; i++) {
    const unsigned char *r = c->idx + 48 + i * 24;
    uint32_t po = get_le32(r);
    uint32_t pl = get_le32(r + 4);
    if((uint64_t)po + pl >= path_bytes || c->idx[paths_off + po + pl] != 0 ||
       pl < 7 || strncmp((const char *)c->idx + paths_off + po, "/app0/", 6)) {
      ctx_err(c, "generated AMPR index has a bad path");
      return -1;
    }
    ap_item_t *it = &c->items[i];
    it->app0 = (const char *)c->idx + paths_off + po;
    it->rel = it->app0 + 6;
    it->path_len = pl;
    it->size = get_le64(r + 8);
    it->idx_mtime = (int64_t)get_le64(r + 16);
    it->mtime = it->idx_mtime;
    it->path_hash = fnv1a64_folded(it->app0);
    it->path_offset = (uint32_t)strings;
    strings += (uint64_t)pl + 1;
    if(strings > 0xFFFFFFFFULL) {
      ctx_err(c, "path table exceeds the AMPRPAK4 limit");
      return -1;
    }
  }
  c->strings_size = strings;
  return 0;
}

/* ------------------------------------------------------------- plan */

/* _auto_loose_decision(): sample blocks across the file, compress them with
 * the file's rule and keep the file loose when LZ4 barely helps. */
static int
auto_loose_decide(ap_ctx_t *c, ap_item_t *it, int *use_loose) {
  const ap_rule_t *r = it->rule;
  *use_loose = 0;
  if(!c->cfg.auto_loose_large_files || it->action != AP_ACTION_COMPRESS ||
     r->force_pack || (r->hot && !c->cfg.auto_loose_hot_files) ||
     it->size < c->cfg.auto_loose_min_file_size || it->size == 0) {
    return 0;
  }
  uint64_t block = 1ULL << r->block_shift;
  uint64_t total_blocks = (it->size + block - 1) / block;
  uint64_t byte_limited = c->cfg.auto_loose_sample_bytes / block;
  if(byte_limited < 1) byte_limited = 1;
  uint64_t sample = c->cfg.auto_loose_sample_blocks;
  if(sample > byte_limited) sample = byte_limited;
  uint64_t indices[4096];
  size_t nidx = 0;
  if(total_blocks <= sample) {
    for(uint64_t b = 0; b < total_blocks; b++) indices[nidx++] = b;
  } else if(sample == 1) {
    indices[nidx++] = total_blocks / 2;
  } else {
    for(uint64_t s = 0; s < sample; s++) {
      uint64_t v = (s * (total_blocks - 1)) / (sample - 1);
      if(nidx == 0 || indices[nidx - 1] != v) indices[nidx++] = v;
    }
  }
  char path[1024];
  if(join2(path, sizeof(path), c->src, it->rel) != 0) {
    ctx_err(c, "path too long: %s", it->rel);
    return -1;
  }
  int fd = open(path, O_RDONLY);
  if(fd < 0) {
    ctx_err(c, "open %s: %s", it->rel, strerror(errno));
    return -1;
  }
  struct stat before, after;
  fstat(fd, &before);
  uint32_t io_page = group_io_page(c, r->group);
  uint64_t sampled = 0, stored = 0, raw_blocks = 0;
  for(size_t base = 0; base < nidx; base += c->slot_count) {
    size_t batch = nidx - base < c->slot_count ? nidx - base : c->slot_count;
    for(size_t i = 0; i < batch; i++) {
      ap_slot_t *s = &c->slots[i];
      uint64_t off = indices[base + i] * block;
      uint32_t len = (uint32_t)((it->size - off) < block ? (it->size - off) : block);
      if(pread_full(fd, s->raw, len, off) != (ssize_t)len) {
        close(fd);
        for(size_t k = 0; k < i; k++) {
          pool_wait(&c->pool, &c->slots[k]);
          c->slots[k].state = 0;
        }
        ctx_err(c, "source was truncated while sampling: %s", it->rel);
        return -1;
      }
      s->raw_len = len;
      slot_set_rule(s, r, it->action, io_page, 0);
      pool_submit(&c->pool, s);
    }
    for(size_t i = 0; i < batch; i++) {
      ap_slot_t *s = &c->slots[i];
      pool_wait(&c->pool, s);
      s->state = 0;
      sampled += s->raw_len;
      stored += s->stored_len;
      raw_blocks += s->codec == CHUNK_CODEC_RAW;
    }
  }
  fstat(fd, &after);
  close(fd);
  if(after.st_size != before.st_size || after.st_mtime != before.st_mtime ||
     after.st_ino != before.st_ino || after.st_dev != before.st_dev) {
    ctx_err(c, "source changed while sampling: %s", it->rel);
    return -1;
  }
  double savings = sampled ? 1.0 - (double)stored / (double)sampled : 0.0;
  double raw_ratio = nidx ? (double)raw_blocks / (double)nidx : 0.0;
  *use_loose = savings < c->cfg.auto_loose_min_savings_ratio ||
               raw_ratio >= c->cfg.auto_loose_max_raw_ratio;
  if(*use_loose) {
    cb_log(&c->cb, "auto-loose: %s size=%llu saving=%.2f%% rawBlocks=%.2f%%",
           it->rel, (unsigned long long)it->size, savings * 100.0,
           raw_ratio * 100.0);
  }
  return 0;
}

typedef struct lane_sort {
  uint64_t size;
  const char *rel;
  uint32_t file_id;
  ap_item_t *item;
} lane_sort_t;

static int
lane_sort_cmp(const void *a, const void *b) {
  const lane_sort_t *x = a;
  const lane_sort_t *y = b;
  if(x->size != y->size) return x->size > y->size ? -1 : 1;
  /* str.lower() comparison; ASCII-folded for game paths. */
  const unsigned char *p = (const unsigned char *)x->rel;
  const unsigned char *q = (const unsigned char *)y->rel;
  while(*p || *q) {
    int cp = ascii_tolower(*p);
    int cq = ascii_tolower(*q);
    if(cp != cq) return cp - cq;
    if(*p) p++;
    if(*q) q++;
  }
  return x->file_id < y->file_id ? -1 : (x->file_id > y->file_id);
}

static int
assign_lanes(ap_ctx_t *c) {
  lane_sort_t *buf = calloc(c->item_count ? c->item_count : 1, sizeof(*buf));
  if(!buf) {
    ctx_err(c, "out of memory");
    return -1;
  }
  for(size_t g = 0; g < c->cfg.group_count; g++) {
    const ap_group_t *grp = &c->cfg.groups[g];
    size_t n = 0;
    for(size_t i = 0; i < c->item_count; i++) {
      ap_item_t *it = &c->items[i];
      if(it->action == AP_ACTION_LOOSE || it->rule->group != (int)g) continue;
      buf[n].size = it->size;
      buf[n].rel = it->rel;
      buf[n].file_id = (uint32_t)i + 1;
      buf[n].item = it;
      n++;
    }
    if(!n) continue;
    if(grp->assignment == AP_ASSIGN_BALANCED) {
      uint64_t *loads = calloc(grp->pack_count, sizeof(*loads));
      if(!loads) {
        free(buf);
        ctx_err(c, "out of memory");
        return -1;
      }
      qsort(buf, n, sizeof(*buf), lane_sort_cmp);
      for(size_t i = 0; i < n; i++) {
        uint32_t best = 0;
        for(uint32_t l = 1; l < grp->pack_count; l++) {
          if(loads[l] < loads[best]) best = l;
        }
        buf[i].item->lane = best;
        loads[best] += buf[i].size;
      }
      free(loads);
    } else if(grp->assignment == AP_ASSIGN_HASH) {
      for(size_t i = 0; i < n; i++) {
        buf[i].item->lane = (uint32_t)(fnv1a64_folded(buf[i].rel) % grp->pack_count);
      }
    } else {
      for(size_t i = 0; i < n; i++) {
        buf[i].item->lane = (buf[i].file_id - 1) % grp->pack_count;
      }
    }
  }
  free(buf);
  return 0;
}

/* Files the PS5 looks at outside the game process, where the APR-EMU can't
 * show packed files, so they must stay on disk: empty files (PlayGo language
 * placeholders), PlayGo's chunk markers, and the Sucker Punch boot files
 * Ghost of Yotei needs to get past a black screen (found by a Reddit user,
 * confirmed on PPSA26344 02.002.000). */
static const char *const k_keep_on_disk[] = {
  "cache_ps5/pgc_*_dummy_file",
  "cache_ps5/playgo.pgm",
  "cache_ps5/load_menu_catalog.log",
  "cache_ps5/all_shaders.texmeshman",
  "cache_ps5/game.sprig.packman",
  "cache_ps5/game.sprig.texmeshman",
  "cache_ps5/pulse.sprig.texmeshman",
  "sounds/scream/_generated/buss_config.bus",
  "sounds/scream/_generated/distance_model.dml",
  "sounds/scream/_generated/group_mix.gmx",
};

int
ampr_pack_keep_on_disk(const char *rel, uint64_t size) {
  if(size == 0) return 1;
  while(rel && *rel == '/') rel++;
  for(size_t i = 0; rel && i < sizeof(k_keep_on_disk) / sizeof(k_keep_on_disk[0]); i++) {
    if(ap_fnmatch(k_keep_on_disk[i], rel)) return 1;
  }
  return 0;
}

static int
plan_files(ap_ctx_t *c) {
  char glob[256];
  ap_strlist_t pack_glob = {0};
  snprintf(glob, sizeof(glob), "%s", c->cfg.pack_output_glob);
  if(ap_strlist_add(&pack_glob, glob) != 0) {
    ctx_err(c, "out of memory");
    return -1;
  }
  char idx_crc[300], idx_rt[300];
  snprintf(idx_crc, sizeof(idx_crc), "%s.crc", c->cfg.index_name);
  snprintf(idx_rt, sizeof(idx_rt), "%s.runtime", c->cfg.index_name);
  cb_phase(&c->cb, "lz4-plan", "Choosing files to pack");
  uint64_t planned = 0;
  for(size_t i = 0; i < c->item_count; i++) {
    ap_item_t *it = &c->items[i];
    const ap_rule_t *sel = ap_config_select_rule(&c->cfg, it->rel, &it->own_rule);
    if(sel == &it->own_rule) {
      it->rule = &it->own_rule;
    } else {
      it->rule = sel;
    }
    it->action = it->rule->action;
    if(ap_glob_matches(it->rel, &c->cfg.force_loose) ||
       ampr_pack_keep_on_disk(it->rel, it->size)) {
      it->action = AP_ACTION_LOOSE;
    }
    if(!strcmp(it->rel, c->cfg.index_name) || !strcmp(it->rel, idx_crc) ||
       !strcmp(it->rel, idx_rt) || ap_glob_matches(it->rel, &pack_glob)) {
      it->action = AP_ACTION_LOOSE;
    }
    if(it->action != AP_ACTION_LOOSE) {
      char path[1024];
      struct stat st;
      if(join2(path, sizeof(path), c->src, it->rel) != 0 ||
         lstat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
        ap_strlist_free(&pack_glob);
        ctx_err(c, "source is missing or not a regular file: %s", it->rel);
        return -1;
      }
      if(c->cfg.validate_index_metadata && (uint64_t)st.st_size != it->size) {
        ap_strlist_free(&pack_glob);
        ctx_err(c, "AMPR index size mismatch for %s", it->rel);
        return -1;
      }
      it->size = (uint64_t)st.st_size;
      it->mtime = (int64_t)st.st_mtime;
      int use_loose = 0;
      cb_current(&c->cb, it->rel);
      if(auto_loose_decide(c, it, &use_loose) != 0) {
        ap_strlist_free(&pack_glob);
        return -1;
      }
      if(use_loose) {
        if(c->cfg.self_contained) {
          cb_log(&c->cb, "self-contained: auto-loose suppressed for %s", it->rel);
        } else {
          it->action = AP_ACTION_LOOSE;
          c->st->files_auto_loose++;
        }
      }
    }
    planned++;
    cb_progress(&c->cb, planned, c->item_count, 0);
    if(ctx_check_cancel(c) != 0) {
      ap_strlist_free(&pack_glob);
      return -1;
    }
  }
  ap_strlist_free(&pack_glob);
  cb_progress(&c->cb, c->item_count, c->item_count, 1);
  if(c->cfg.required_packed.count) {
    for(size_t i = 0; i < c->item_count; i++) {
      if(c->items[i].action == AP_ACTION_LOOSE &&
         !ampr_pack_keep_on_disk(c->items[i].rel, c->items[i].size) &&
         ap_glob_matches(c->items[i].rel, &c->cfg.required_packed)) {
        ctx_err(c, "required_packed matched a file that would remain loose: %s",
                c->items[i].rel);
        return -1;
      }
    }
  }
  if(assign_lanes(c) != 0) return -1;
  uint64_t running = 0;
  for(size_t i = 0; i < c->item_count; i++) {
    ap_item_t *it = &c->items[i];
    if(it->action == AP_ACTION_LOOSE) continue;
    uint64_t block = 1ULL << it->rule->block_shift;
    uint64_t count = (it->size + block - 1) / block;
    if(running > 0xFFFFFFFFULL || count > 0xFFFFFFFFULL) {
      ctx_err(c, "chunk count exceeds the AMPRPAK4 limit");
      return -1;
    }
    it->first_chunk = (uint32_t)running;
    it->chunk_count = (uint32_t)count;
    running += count;
  }
  if(running > RUNTIME_MAX_CHUNKS) {
    ctx_err(c, "%llu chunks exceed the LZ4 runtime limit of 16,000,000; use a larger block size",
            (unsigned long long)running);
    return -1;
  }
  c->chunk_total = running;
  return 0;
}

/* ------------------------------------------------------------- pack */

static ap_writer_t *
new_volume(ap_ctx_t *c, int group, uint32_t lane, uint32_t flags) {
  const ap_group_t *grp = &c->cfg.groups[group];
  uint32_t pack_id = (uint32_t)c->writer_count;
  if(pack_id > 0xFFFF || pack_id >= RUNTIME_MAX_PACKS) {
    ctx_err(c, "too many pack volumes for the LZ4 runtime (limit 1024)");
    return NULL;
  }
  if(c->writer_count == c->writer_cap) {
    size_t next = c->writer_cap ? c->writer_cap * 2 : 16;
    ap_writer_t **w = realloc(c->writers, next * sizeof(*w));
    if(!w) {
      ctx_err(c, "out of memory");
      return NULL;
    }
    c->writers = w;
    c->writer_cap = next;
  }
  ap_writer_t *w = calloc(1, sizeof(*w));
  if(!w) {
    ctx_err(c, "out of memory");
    return NULL;
  }
  w->fd = -1;
  w->pack_id = pack_id;
  w->group = group;
  w->lane = lane;
  w->volume = c->volume_numbers[group][lane]++;
  if(ap_render_pack_name(&c->cfg, grp->name, lane, w->volume, pack_id, w->name,
                         sizeof(w->name)) != 0 || strlen(w->name) > 1017) {
    free(w);
    ctx_err(c, "pack_pattern produced an invalid name");
    return NULL;
  }
  for(size_t i = 0; i < c->writer_count; i++) {
    if(!strcmp(c->writers[i]->name, w->name)) {
      ctx_err(c, "pack_pattern produced duplicate name: %s", w->name);
      free(w);
      return NULL;
    }
  }
  if(join2(w->final_path, sizeof(w->final_path), c->out, w->name) != 0) {
    free(w);
    ctx_err(c, "pack path too long");
    return NULL;
  }
  struct stat st;
  if(lstat(w->final_path, &st) == 0) {
    ctx_err(c, "a file named like a pack volume already exists: %s", w->name);
    free(w);
    return NULL;
  }
  char *slash = strrchr(w->final_path, '/');
  snprintf(w->temp_path, sizeof(w->temp_path), "%.*s/.%s.lzc-lz4-%u.tmp",
           (int)(slash - w->final_path), w->final_path, slash + 1, pack_id);
  w->io_page = group_io_page(c, group);
  w->chunk_align = c->cfg.chunk_alignment;
  w->max_pack_size = grp->max_pack_size;
  w->flags = flags | PACK_FLAG_IO_PAGE_LAYOUT;
  uint32_t pa = c->cfg.payload_alignment > w->io_page ? c->cfg.payload_alignment
                                                      : w->io_page;
  w->payload_offset = align_up(DATA_HEADER_SIZE, pa);
  w->buf = malloc(AP_IO_BUFFER);
  if(!w->buf || mkdirs_parent(w->final_path) != 0) {
    free(w->buf);
    free(w);
    ctx_err(c, "could not prepare pack volume");
    return NULL;
  }
  w->fd = open(w->temp_path, O_RDWR | O_CREAT | O_TRUNC, 0777);
  if(w->fd >= 0) (void)fchmod(w->fd, 0777);
  if(w->fd < 0) {
    ctx_err(c, "create %s: %s", w->name, strerror(errno));
    free(w->buf);
    free(w);
    return NULL;
  }
  c->writers[c->writer_count++] = w;
  if(writer_put(w, NULL, (size_t)w->payload_offset) != 0) {
    ctx_err(c, "write %s: %s", w->name, strerror(errno));
    return NULL;
  }
  w->position = w->payload_offset;
  w->padding = w->payload_offset - DATA_HEADER_SIZE;
  c->current[group][lane] = (int32_t)pack_id;
  c->st->pack_count = (uint32_t)c->writer_count;
  return w;
}

/* Flushes and closes a volume that will not receive more data. */
static int
writer_retire(ap_ctx_t *c, ap_writer_t *w) {
  if(w->fd < 0) return 0;
  if(writer_flush(w) != 0) {
    ctx_err(c, "write %s: %s", w->name, strerror(errno));
    return -1;
  }
  free(w->buf);
  w->buf = NULL;
  if(close(w->fd) != 0) {
    w->fd = -1;
    ctx_err(c, "close %s: %s", w->name, strerror(errno));
    return -1;
  }
  w->fd = -1;
  return 0;
}

static ap_writer_t *
writer_for(ap_ctx_t *c, int group, uint32_t lane, uint32_t stored, int striped,
           int streaming, int extent_start) {
  uint32_t flags = PACK_FLAG_IO_PAGE_LAYOUT | (striped ? PACK_FLAG_STRIPED : 0);
  int32_t cur = c->current[group][lane];
  ap_writer_t *w = cur >= 0 ? c->writers[cur] : NULL;
  if(!w) {
    w = new_volume(c, group, lane, flags);
    if(!w) return NULL;
  }
  if(!writer_can_fit(w, stored, streaming, extent_start)) {
    if(writer_retire(c, w) != 0) return NULL;
    w = new_volume(c, group, lane, flags);
    if(!w) return NULL;
    if(!writer_can_fit(w, stored, streaming, 1)) {
      ctx_err(c, "one block exceeds max_pack_size for group %s",
              c->cfg.groups[group].name);
      return NULL;
    }
  }
  if(striped) w->flags |= PACK_FLAG_STRIPED;
  return w;
}

static uint32_t
item_file_flags(const ap_item_t *it) {
  uint32_t flags = FILE_FLAG_PACKED;
  int layout = ap_rule_resolved_layout(it->rule);
  if(it->action == AP_ACTION_STORE) flags |= FILE_FLAG_STORE_ONLY;
  if(layout == AP_LAYOUT_STREAMING) flags |= FILE_FLAG_STREAMING;
  else if(layout == AP_LAYOUT_RANDOM) flags |= FILE_FLAG_RANDOM_ACCESS;
  if(it->rule->hot) flags |= FILE_FLAG_HOT;
  return flags;
}

/* Places one compressed block exactly like build_packs() does. */
static int
consume_slot(ap_ctx_t *c, ap_slot_t *s) {
  ap_item_t *it = &c->items[s->item];
  const ap_rule_t *r = it->rule;
  const ap_group_t *grp = &c->cfg.groups[r->group];
  int streaming = ap_rule_resolved_layout(r) == AP_LAYOUT_STREAMING;
  int striped = grp->stripe_large_files && grp->pack_count > 1 &&
                it->size >= grp->stripe_threshold;
  uint32_t lane = it->lane;
  if(striped) {
    lane = (uint32_t)((it->lane + s->block / grp->stripe_group_blocks) %
                      grp->pack_count);
  }
  uint32_t domain = c->cfg.dedupe_scope_group
      ? ((uint32_t)r->group << 16) | 0xFFFFu
      : ((uint32_t)r->group << 16) | (lane & 0xFFFFu);
  uint32_t tag = (domain << 2) | ((uint32_t)streaming << 1) | (uint32_t)s->codec;
  int allow_dedupe = c->cfg.deduplicate &&
                     (!streaming || c->cfg.deduplicate_streaming);
  uint32_t chunk_index = it->first_chunk + s->block;
  uint64_t loc;
  uint32_t desc;
  int64_t prior = allow_dedupe ? dedupe_find(&c->dd, s->h1, s->h2, tag) : -1;
  if(prior >= 0) {
    uint32_t pd = c->chunk_desc[prior];
    uint32_t pflags = (pd >> 22) & 0xFFu;
    uint32_t flags = CHUNK_FLAG_SHARED |
                     (pflags & (CHUNK_FLAG_PAGE_CONTAINED | CHUNK_FLAG_PAGE_ALIGNED)) |
                     (streaming ? CHUNK_FLAG_STREAMING : 0);
    loc = c->chunk_loc[prior];
    desc = (pd & ((1u << 22) - 1)) | (flags << 22);
    c->st->chunks_shared++;
  } else {
    int extent_start = streaming &&
        (s->block == 0 || (striped && s->block % grp->stripe_group_blocks == 0));
    const unsigned char *stored = s->codec == CHUNK_CODEC_LZ4 ? s->out : s->raw;
    ap_writer_t *w = writer_for(c, r->group, lane, s->stored_len, striped,
                                streaming, extent_start);
    if(!w) return -1;
    uint64_t off;
    uint32_t pflags;
    if(writer_write(w, stored, s->stored_len, streaming, extent_start, &off,
                    &pflags) != 0) {
      ctx_err(c, "write %s: %s", w->name, strerror(errno));
      return -1;
    }
    uint32_t flags = (streaming ? CHUNK_FLAG_STREAMING : 0) | pflags;
    int page_safe = s->stored_len <= w->io_page
        ? (pflags & CHUNK_FLAG_PAGE_CONTAINED) != 0
        : (pflags & CHUNK_FLAG_PAGE_ALIGNED) != 0;
    if(!streaming && !page_safe) {
      ctx_err(c, "non-streaming chunk was not placed page-safely");
      return -1;
    }
    if(off > CHUNK_OFFSET_MASK) {
      ctx_err(c, "pack offset exceeds the 48-bit AMPRPAK4 domain");
      return -1;
    }
    loc = off | ((uint64_t)w->pack_id << 48);
    desc = (s->stored_len - 1) | ((uint32_t)s->codec << 20) | (flags << 22);
    if(allow_dedupe) dedupe_insert(&c->dd, s->h1, s->h2, tag, chunk_index);
    c->st->stored_bytes += s->stored_len;
  }
  c->chunk_loc[chunk_index] = loc;
  c->chunk_desc[chunk_index] = desc;
  c->chunk_crc[chunk_index] = s->raw_crc;
  c->st->chunks++;
  c->st->logical_bytes += s->raw_len;
  if(s->codec == CHUNK_CODEC_LZ4) c->st->chunks_lz4++;
  else c->st->chunks_raw++;
  return 0;
}

static int
pack_files(ap_ctx_t *c) {
  uint64_t total = 0;
  uint64_t done = 0;
  for(size_t i = 0; i < c->item_count; i++) {
    if(c->items[i].action != AP_ACTION_LOOSE) total += c->items[i].size;
  }
  c->chunk_loc = calloc(c->chunk_total ? c->chunk_total : 1, sizeof(uint64_t));
  c->chunk_desc = calloc(c->chunk_total ? c->chunk_total : 1, sizeof(uint32_t));
  c->chunk_crc = calloc(c->chunk_total ? c->chunk_total : 1, sizeof(uint32_t));
  if(!c->chunk_loc || !c->chunk_desc || !c->chunk_crc) {
    ctx_err(c, "out of memory for %llu chunk records",
            (unsigned long long)c->chunk_total);
    return -1;
  }
  if(c->cfg.deduplicate && dedupe_init(&c->dd, c->chunk_total) != 0) {
    cb_log(&c->cb, "deduplication disabled: not enough memory");
  }
  cb_phase(&c->cb, "lz4-pack", "Compressing with LZ4");
  cb_progress(&c->cb, 0, total, 1);

  size_t next_submit = 0;
  size_t next_consume = 0;
  int want_hash = c->dd.slots != NULL;
  for(size_t i = 0; i < c->item_count; i++) {
    ap_item_t *it = &c->items[i];
    if(it->action == AP_ACTION_LOOSE) continue;
    if(it->chunk_count == 0) {
      c->st->files_packed++;
      continue;
    }
    char path[1024];
    if(join2(path, sizeof(path), c->src, it->rel) != 0) {
      ctx_err(c, "path too long: %s", it->rel);
      goto fail;
    }
    int fd = open(path, O_RDONLY);
    if(fd < 0) {
      ctx_err(c, "open %s: %s", it->rel, strerror(errno));
      goto fail;
    }
    struct stat before, after;
    if(fstat(fd, &before) != 0 || (uint64_t)before.st_size != it->size) {
      close(fd);
      ctx_err(c, "source changed before packing: %s", it->rel);
      goto fail;
    }
    cb_current(&c->cb, it->rel);
    uint32_t io_page = group_io_page(c, it->rule->group);
    uint64_t block = 1ULL << it->rule->block_shift;
    uint64_t remaining = it->size;
    for(uint32_t b = 0; b < it->chunk_count; b++) {
      ap_slot_t *s = &c->slots[next_submit % c->slot_count];
      if(s->state != 0) {
        /* FIFO ring: the slot being reused is the oldest in flight. */
        pool_wait(&c->pool, s);
        if(consume_slot(c, s) != 0) {
          close(fd);
          goto fail;
        }
        done += s->raw_len;
        s->state = 0;
        next_consume++;
        cb_progress(&c->cb, done, total, 0);
      }
      uint32_t len = (uint32_t)(remaining < block ? remaining : block);
      ssize_t n = read_full(fd, s->raw, len);
      if(n != (ssize_t)len) {
        close(fd);
        ctx_err(c, "source was truncated while packing: %s", it->rel);
        goto fail;
      }
      remaining -= len;
      s->raw_len = len;
      s->item = (uint32_t)i;
      s->block = b;
      slot_set_rule(s, it->rule, it->action, io_page, want_hash);
      pool_submit(&c->pool, s);
      next_submit++;
      if((b & 63) == 0 && ctx_check_cancel(c) != 0) {
        close(fd);
        goto fail;
      }
    }
    unsigned char extra;
    if(read(fd, &extra, 1) != 0 || fstat(fd, &after) != 0 ||
       after.st_size != before.st_size || after.st_mtime != before.st_mtime ||
       after.st_ino != before.st_ino || after.st_dev != before.st_dev) {
      close(fd);
      ctx_err(c, "source changed while packing: %s", it->rel);
      goto fail;
    }
    close(fd);
    c->st->files_packed++;
  }
  while(next_consume < next_submit) {
    ap_slot_t *s = &c->slots[next_consume % c->slot_count];
    pool_wait(&c->pool, s);
    if(consume_slot(c, s) != 0) goto fail;
    done += s->raw_len;
    s->state = 0;
    next_consume++;
    cb_progress(&c->cb, done, total, 0);
  }
  cb_progress(&c->cb, total, total, 1);
  return 0;

fail:
  /* Drain in-flight work so slots are not reused by running workers. */
  for(size_t i = 0; i < c->slot_count; i++) {
    if(c->slots[i].state == 1) pool_wait(&c->pool, &c->slots[i]);
    c->slots[i].state = 0;
  }
  return -1;
}

/* ---------------------------------------------------- serialization */

typedef int (*ap_sink_fn)(void *arg, const void *data, size_t len);

typedef struct ap_emitter {
  unsigned char buf[65536];
  size_t len;
  ap_sink_fn sink;
  void *arg;
  int failed;
} ap_emitter_t;

static void
emit(ap_emitter_t *e, const void *data, size_t len) {
  const unsigned char *p = data;
  while(len && !e->failed) {
    if(e->len == sizeof(e->buf)) {
      if(e->sink(e->arg, e->buf, e->len) != 0) e->failed = 1;
      e->len = 0;
    }
    size_t take = sizeof(e->buf) - e->len;
    if(take > len) take = len;
    memcpy(e->buf + e->len, p, take);
    e->len += take;
    p += take;
    len -= take;
  }
}

static int
emit_flush(ap_emitter_t *e) {
  if(!e->failed && e->len && e->sink(e->arg, e->buf, e->len) != 0) e->failed = 1;
  e->len = 0;
  return e->failed ? -1 : 0;
}

static void
emit_file_records(ap_ctx_t *c, ap_emitter_t *e) {
  unsigned char r[FILE_RECORD_SIZE];
  for(size_t i = 0; i < c->item_count; i++) {
    const ap_item_t *it = &c->items[i];
    memset(r, 0, sizeof(r));
    put_le64(r, it->path_hash);
    if(it->action == AP_ACTION_LOOSE) {
      put_le64(r + 8, it->size);
      put_le64(r + 16, (uint64_t)it->idx_mtime);
    } else {
      put_le64(r + 8, it->size);
      put_le64(r + 16, (uint64_t)(c->cfg.preserve_mtime ? it->mtime : it->idx_mtime));
      put_le32(r + 24, it->first_chunk);
      put_le32(r + 28, it->chunk_count);
      r[44] = (unsigned char)it->rule->block_shift;
      r[45] = c->cfg.groups[it->rule->group].packing_class;
      put_le32(r + 40, item_file_flags(it));
    }
    put_le32(r + 32, it->path_offset);
    put_le32(r + 36, it->path_len);
    emit(e, r, sizeof(r));
  }
}

static void
emit_chunk_records(ap_ctx_t *c, ap_emitter_t *e) {
  unsigned char r[CHUNK_RECORD_SIZE];
  for(uint64_t i = 0; i < c->chunk_total; i++) {
    put_le64(r, c->chunk_loc[i]);
    put_le32(r + 8, c->chunk_desc[i]);
    emit(e, r, sizeof(r));
  }
}

static void
emit_crc_payload(ap_ctx_t *c, ap_emitter_t *e) {
  unsigned char r[4];
  for(uint64_t i = 0; i < c->chunk_total; i++) {
    put_le32(r, c->chunk_crc[i]);
    emit(e, r, 4);
  }
}

static void
emit_pack_records(ap_ctx_t *c, ap_emitter_t *e) {
  unsigned char r[PACK_RECORD_SIZE];
  uint64_t name_off = c->strings_size;
  for(size_t i = 0; i < c->writer_count; i++) {
    const ap_writer_t *w = c->writers[i];
    uint64_t final = w->finalized ? w->final_size : align_up(w->position, w->io_page);
    memset(r, 0, sizeof(r));
    put_le64(r, final - w->payload_offset);
    put_le64(r + 8, final);
    put_le32(r + 16, (uint32_t)name_off);
    put_le32(r + 20, (uint32_t)strlen(w->name));
    put_le32(r + 24, w->flags);
    put_le32(r + 28, w->io_page);
    emit(e, r, sizeof(r));
    name_off += strlen(w->name) + 1;
  }
}

static void
emit_strings(ap_ctx_t *c, ap_emitter_t *e) {
  for(size_t i = 0; i < c->item_count; i++) {
    emit(e, c->items[i].app0, (size_t)c->items[i].path_len + 1);
  }
  for(size_t i = 0; i < c->writer_count; i++) {
    emit(e, c->writers[i]->name, strlen(c->writers[i]->name) + 1);
  }
}

static uint64_t
total_strings_size(const ap_ctx_t *c) {
  uint64_t n = c->strings_size;
  for(size_t i = 0; i < c->writer_count; i++) n += strlen(c->writers[i]->name) + 1;
  return n;
}

static int
sink_sha(void *arg, const void *data, size_t len) {
  sha256_update(arg, data, len);
  return 0;
}

typedef struct crc_sink {
  uint32_t crc;
} crc_sink_t;

static int
sink_crc(void *arg, const void *data, size_t len) {
  crc_sink_t *s = arg;
  s->crc = crc32_buf(s->crc, data, len);
  return 0;
}

typedef struct fd_sink {
  int fd;
  uint32_t crc;
} fd_sink_t;

static int
sink_fd(void *arg, const void *data, size_t len) {
  fd_sink_t *s = arg;
  s->crc = crc32_buf(s->crc, data, len);
  return write_all(s->fd, data, len);
}

static void
config_canonical(ap_ctx_t *c, ap_sha256_t *sha) {
  char line[1024];
  const ap_config_t *cfg = &c->cfg;
#define CANON(...) do { int n__ = snprintf(line, sizeof(line), __VA_ARGS__); \
    if(n__ > 0) sha256_update(sha, line, (size_t)n__ < sizeof(line) ? (size_t)n__ : sizeof(line) - 1); } while(0)
  CANON("ps5-lz4-compression ampr_pack 4.0\n");
  CANON("index=%s pattern=%s default=%d block=%d io=%u payload=%u chunk=%u\n",
        cfg->index_name, cfg->pack_pattern, cfg->default_action,
        cfg->default_block_shift, cfg->io_page_size, cfg->payload_alignment,
        cfg->chunk_alignment);
  CANON("hc=%d level=%d accel=%d save=%llu/%.6f neutral=%llu/%.6f\n",
        cfg->mode_hc, cfg->level, cfg->acceleration,
        (unsigned long long)cfg->min_savings_bytes, cfg->min_savings_ratio,
        (unsigned long long)cfg->io_neutral_min_savings_bytes,
        cfg->io_neutral_min_savings_ratio);
  CANON("dedupe=%d scope=%d stream=%d auto=%d hot=%d min=%llu blocks=%u bytes=%llu %.6f %.6f\n",
        cfg->deduplicate, cfg->dedupe_scope_group, cfg->deduplicate_streaming,
        cfg->auto_loose_large_files, cfg->auto_loose_hot_files,
        (unsigned long long)cfg->auto_loose_min_file_size,
        cfg->auto_loose_sample_blocks,
        (unsigned long long)cfg->auto_loose_sample_bytes,
        cfg->auto_loose_min_savings_ratio, cfg->auto_loose_max_raw_ratio);
  for(size_t i = 0; i < cfg->group_count; i++) {
    const ap_group_t *g = &cfg->groups[i];
    CANON("group %s %u %d %llu %d %llu %u %u\n", g->name, g->pack_count,
          g->assignment, (unsigned long long)g->max_pack_size,
          g->stripe_large_files, (unsigned long long)g->stripe_threshold,
          g->stripe_group_blocks, g->io_page_size);
  }
  for(size_t i = 0; i < cfg->rule_count; i++) {
    const ap_rule_t *r = &cfg->rules[i];
    CANON("rule %d %d %d %d %d %d %llu %.6f %llu %.6f %d %d %d %d\n",
          r->action, r->block_shift, r->group, r->mode_hc, r->level,
          r->acceleration, (unsigned long long)r->min_savings_bytes,
          r->min_savings_ratio,
          (unsigned long long)r->io_neutral_min_savings_bytes,
          r->io_neutral_min_savings_ratio, r->layout, r->streaming, r->hot,
          r->force_pack);
    for(size_t k = 0; k < r->include.count; k++) CANON("+%s\n", r->include.items[k]);
    for(size_t k = 0; k < r->exclude.count; k++) CANON("-%s\n", r->exclude.items[k]);
  }
  for(size_t k = 0; k < cfg->force_loose.count; k++) {
    CANON("!%s\n", cfg->force_loose.items[k]);
  }
#undef CANON
}

/* deterministic_build_id(): SHA-256("AMPRPACK4\0" + (u64 len, part)...)[:16] */
static void
compute_build_id(ap_ctx_t *c) {
  ap_sha256_t sha;
  ap_sha256_t cfg_sha;
  unsigned char cfg_digest[32];
  unsigned char lenb[8];
  unsigned char digest[32];
  ap_emitter_t *e = malloc(sizeof(*e));

  sha256_init(&cfg_sha);
  config_canonical(c, &cfg_sha);
  sha256_final(&cfg_sha, cfg_digest);

  sha256_init(&sha);
  sha256_update(&sha, "AMPRPACK4\0", 10);
  put_le64(lenb, sizeof(cfg_digest));
  sha256_update(&sha, lenb, 8);
  sha256_update(&sha, cfg_digest, sizeof(cfg_digest));
  if(e) {
    memset(e, 0, sizeof(*e));
    e->sink = sink_sha;
    e->arg = &sha;
    put_le64(lenb, (uint64_t)c->item_count * FILE_RECORD_SIZE);
    sha256_update(&sha, lenb, 8);
    emit_file_records(c, e);
    emit_flush(e);
    put_le64(lenb, c->chunk_total * CHUNK_RECORD_SIZE);
    sha256_update(&sha, lenb, 8);
    emit_chunk_records(c, e);
    emit_flush(e);
    put_le64(lenb, c->chunk_total * 4);
    sha256_update(&sha, lenb, 8);
    emit_crc_payload(c, e);
    emit_flush(e);
    put_le64(lenb, (uint64_t)c->writer_count * PACK_RECORD_SIZE);
    sha256_update(&sha, lenb, 8);
    emit_pack_records(c, e);
    emit_flush(e);
    put_le64(lenb, total_strings_size(c));
    sha256_update(&sha, lenb, 8);
    emit_strings(c, e);
    emit_flush(e);
    free(e);
  }
  sha256_final(&sha, digest);
  memcpy(c->build_id, digest, 16);
  for(int i = 0; i < 16; i++) {
    snprintf(c->st->build_id + i * 2, 3, "%02x", c->build_id[i]);
  }
}

static int
finalize_volumes(ap_ctx_t *c) {
  for(size_t i = 0; i < c->writer_count; i++) {
    ap_writer_t *w = c->writers[i];
    if(w->fd < 0) {
      w->fd = open(w->temp_path, O_RDWR);
      if(w->fd < 0) {
        ctx_err(c, "reopen %s: %s", w->name, strerror(errno));
        return -1;
      }
      if(lseek(w->fd, (off_t)w->position, SEEK_SET) < 0) {
        ctx_err(c, "seek %s: %s", w->name, strerror(errno));
        return -1;
      }
      if(!w->buf && !(w->buf = malloc(AP_IO_BUFFER))) {
        ctx_err(c, "out of memory");
        return -1;
      }
    }
    uint64_t final = align_up(w->position, w->io_page);
    if(final > w->position) {
      if(writer_put(w, NULL, (size_t)(final - w->position)) != 0) goto werr;
      w->padding += final - w->position;
      w->position = final;
    }
    if(writer_flush(w) != 0) goto werr;
    unsigned char h[DATA_HEADER_SIZE];
    memset(h, 0, sizeof(h));
    memcpy(h, DATA_MAGIC, 8);
    put_le32(h + 8, DATA_VERSION);
    put_le32(h + 12, DATA_HEADER_SIZE);
    put_le32(h + 16, w->pack_id);
    put_le32(h + 20, w->flags);
    memcpy(h + 24, c->build_id, 16);
    put_le64(h + 40, w->payload_offset);
    put_le64(h + 48, final - w->payload_offset);
    put_le32(h + 56, crc32_buf(0, h, sizeof(h)));
    if(pwrite_all(w->fd, h, sizeof(h), 0) != 0 || fsync(w->fd) != 0) goto werr;
    struct stat st;
    if(fstat(w->fd, &st) != 0 || (uint64_t)st.st_size != final) {
      ctx_err(c, "unexpected size for %s", w->name);
      return -1;
    }
    if(close(w->fd) != 0) {
      w->fd = -1;
      goto werr;
    }
    w->fd = -1;
    free(w->buf);
    w->buf = NULL;
    w->final_size = final;
    w->finalized = 1;
    c->st->pack_bytes += final;
    continue;
werr:
    ctx_err(c, "write %s: %s", w->name, strerror(errno));
    return -1;
  }
  return 0;
}

static int
runtime_budget(ap_ctx_t *c, uint64_t manifest_bytes) {
  ap_config_t *cfg = &c->cfg;
  if(!cfg->has_runtime) return 0;
  if(cfg->runtime_auto_budget) {
    uint64_t fixed = 32ULL * 2 * MIB + (uint64_t)cfg->rt_workers * MIB + 32 * MIB;
    uint64_t used = fixed + manifest_bytes + c->idx_size + 16 * MIB;
    uint64_t avail = RUNTIME_POOL_BYTES > used ? RUNTIME_POOL_BYTES - used : 0;
    uint64_t physical = avail / 4;
    if(physical > 64 * MIB) physical = 64 * MIB;
    uint64_t decoded = avail - physical;
    if(decoded > 256 * MIB) decoded = 256 * MIB;
    cfg->rt_physical_cache_bytes = align_down(physical, 16384);
    cfg->rt_decoded_cache_bytes = align_down(decoded, 16384);
  }
  c->st->rt_decoded_cache_bytes = cfg->rt_decoded_cache_bytes;
  c->st->rt_physical_cache_bytes = cfg->rt_physical_cache_bytes;
  c->st->rt_workers = cfg->rt_workers;
  return 0;
}

static int
write_manifest_files(ap_ctx_t *c) {
  ap_emitter_t *e = calloc(1, sizeof(*e));
  int fd = -1;
  int rc = -1;
  char tmp[1100];
  if(!e) {
    ctx_err(c, "out of memory");
    return -1;
  }
  uint64_t files_off = INDEX_HEADER_SIZE;
  uint64_t chunks_off = files_off + (uint64_t)c->item_count * FILE_RECORD_SIZE;
  uint64_t packs_off = chunks_off + c->chunk_total * CHUNK_RECORD_SIZE;
  uint64_t strings_off = packs_off + (uint64_t)c->writer_count * PACK_RECORD_SIZE;
  uint64_t strings_size = total_strings_size(c);
  uint64_t manifest_bytes = strings_off + strings_size;
  if(strings_size > 0xFFFFFFFFULL) {
    ctx_err(c, "string table exceeds the AMPRPAK4 limit");
    goto done;
  }

  /* Payload CRC first; the header precedes the payload. */
  crc_sink_t cs = { 0 };
  e->sink = sink_crc;
  e->arg = &cs;
  emit_file_records(c, e);
  emit_chunk_records(c, e);
  emit_pack_records(c, e);
  emit_strings(c, e);
  emit_flush(e);

  unsigned char h[INDEX_HEADER_SIZE];
  memset(h, 0, sizeof(h));
  memcpy(h, INDEX_MAGIC, 8);
  put_le32(h + 8, INDEX_VERSION);
  put_le32(h + 12, INDEX_HEADER_SIZE);
  put_le32(h + 16, 0);
  put_le32(h + 20, ENDIAN_MARKER);
  memcpy(h + 24, c->build_id, 16);
  put_le64(h + 40, c->item_count);
  put_le64(h + 48, c->chunk_total);
  put_le32(h + 56, (uint32_t)c->writer_count);
  put_le32(h + 60, FILE_RECORD_SIZE);
  put_le32(h + 64, CHUNK_RECORD_SIZE);
  put_le32(h + 68, PACK_RECORD_SIZE);
  put_le64(h + 72, files_off);
  put_le64(h + 80, chunks_off);
  put_le64(h + 88, packs_off);
  put_le64(h + 96, strings_off);
  put_le64(h + 104, strings_size);
  put_le32(h + 112, cs.crc);
  put_le32(h + 116, 0);
  put_le32(h + 116, crc32_buf(0, h, sizeof(h)));

  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->index_path);
  fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
  if(fd >= 0) (void)fchmod(fd, 0777);
  if(fd < 0) {
    ctx_err(c, "create %s: %s", c->cfg.index_name, strerror(errno));
    goto done;
  }
  fd_sink_t fs = { fd, 0 };
  if(write_all(fd, h, sizeof(h)) != 0) goto werr;
  e->sink = sink_fd;
  e->arg = &fs;
  e->failed = 0;
  emit_file_records(c, e);
  emit_chunk_records(c, e);
  emit_pack_records(c, e);
  emit_strings(c, e);
  if(emit_flush(e) != 0 || fs.crc != cs.crc || fsync(fd) != 0) goto werr;
  close(fd);
  fd = -1;
  c->st->manifest_bytes = manifest_bytes;

  /* .crc sidecar */
  char crc_tmp[1200];
  snprintf(crc_tmp, sizeof(crc_tmp), "%s.lzc-lz4.tmp", c->crc_path);
  crc_sink_t pcs = { 0 };
  e->sink = sink_crc;
  e->arg = &pcs;
  e->failed = 0;
  emit_crc_payload(c, e);
  emit_flush(e);
  unsigned char ch[CRC_HEADER_SIZE];
  memset(ch, 0, sizeof(ch));
  memcpy(ch, CRC_MAGIC, 8);
  put_le32(ch + 8, CRC_VERSION);
  put_le32(ch + 12, CRC_HEADER_SIZE);
  memcpy(ch + 16, c->build_id, 16);
  put_le64(ch + 32, c->chunk_total);
  put_le32(ch + 40, pcs.crc);
  put_le32(ch + 44, crc32_buf(0, ch, sizeof(ch)));
  fd = open(crc_tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
  if(fd >= 0) (void)fchmod(fd, 0777);
  if(fd < 0) goto werr;
  fd_sink_t fs2 = { fd, 0 };
  if(write_all(fd, ch, sizeof(ch)) != 0) goto werr;
  e->sink = sink_fd;
  e->arg = &fs2;
  e->failed = 0;
  emit_crc_payload(c, e);
  if(emit_flush(e) != 0 || fsync(fd) != 0) goto werr;
  close(fd);
  fd = -1;

  /* .runtime sidecar (AMPRCFG1) */
  runtime_budget(c, manifest_bytes);
  if(c->cfg.has_runtime) {
    unsigned char rt[RUNTIME_PROFILE_SIZE];
    char rt_tmp[1200];
    memset(rt, 0, sizeof(rt));
    memcpy(rt, CFG_MAGIC, 8);
    put_le32(rt + 8, 1);
    put_le32(rt + 12, RUNTIME_PROFILE_SIZE);
    memcpy(rt + 16, c->build_id, 16);
    put_le64(rt + 32, c->cfg.rt_decoded_cache_bytes);
    put_le64(rt + 40, c->cfg.rt_physical_cache_bytes);
    put_le32(rt + 48, c->cfg.rt_workers);
    put_le32(rt + 52, c->cfg.rt_latency_reserve_workers);
    put_le32(rt + 56, crc32_buf(0, rt, sizeof(rt)));
    snprintf(rt_tmp, sizeof(rt_tmp), "%s.lzc-lz4.tmp", c->runtime_path);
    fd = open(rt_tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
    if(fd >= 0) (void)fchmod(fd, 0777);
    if(fd < 0 || write_all(fd, rt, sizeof(rt)) != 0 || fsync(fd) != 0) goto werr;
    close(fd);
    fd = -1;
  }
  rc = 0;
  goto done;

werr:
  ctx_err(c, "write pack manifest: %s", strerror(errno));
done:
  if(fd >= 0) close(fd);
  free(e);
  return rc;
}

static void
unlink_published(ap_ctx_t *c) {
  char tmp[1200];
  for(size_t i = 0; i < c->writer_count; i++) {
    ap_writer_t *w = c->writers[i];
    if(w->published) unlink(w->final_path);
    else unlink(w->temp_path);
    w->published = 0;
  }
  unlink(c->index_path);
  unlink(c->crc_path);
  unlink(c->runtime_path);
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->index_path);
  unlink(tmp);
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->crc_path);
  unlink(tmp);
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->runtime_path);
  unlink(tmp);
  c->published = 0;
}

/* Volumes first, then the sidecars, then the manifest (fail-closed). */
static int
publish(ap_ctx_t *c) {
  char tmp[1200];
  struct stat st;
  if(lstat(c->index_path, &st) == 0) {
    ctx_err(c, "%s already exists", c->cfg.index_name);
    return -1;
  }
  for(size_t i = 0; i < c->writer_count; i++) {
    ap_writer_t *w = c->writers[i];
    if(rename(w->temp_path, w->final_path) != 0) {
      ctx_err(c, "publish %s: %s", w->name, strerror(errno));
      goto fail;
    }
    w->published = 1;
  }
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->crc_path);
  if(rename(tmp, c->crc_path) != 0) goto rerr;
  if(c->cfg.has_runtime) {
    snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->runtime_path);
    if(rename(tmp, c->runtime_path) != 0) goto rerr;
  } else {
    unlink(c->runtime_path);
  }
  snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", c->index_path);
  if(rename(tmp, c->index_path) != 0) goto rerr;
  c->published = 1;
  return 0;
rerr:
  ctx_err(c, "publish pack manifest: %s", strerror(errno));
fail:
  unlink_published(c);
  return -1;
}

/* ----------------------------------------------------- manifest read */

typedef struct ap_manifest {
  unsigned char *data;
  size_t size;
  uint64_t file_count;
  uint64_t chunk_count;
  uint32_t pack_count;
  const unsigned char *files;
  const unsigned char *chunks;
  const unsigned char *packs;
  const unsigned char *strings;
  uint64_t strings_size;
  unsigned char build_id[16];
  uint32_t *crcs;
  int have_crcs;
  int *pack_fds;
  uint64_t *pack_payload_begin;
  uint64_t *pack_payload_end;
} ap_manifest_t;

static void
manifest_free(ap_manifest_t *m) {
  if(m->pack_fds) {
    for(uint32_t i = 0; i < m->pack_count; i++) {
      if(m->pack_fds[i] >= 0) close(m->pack_fds[i]);
    }
  }
  free(m->pack_fds);
  free(m->pack_payload_begin);
  free(m->pack_payload_end);
  free(m->crcs);
  free(m->data);
  memset(m, 0, sizeof(*m));
}

static const char *
manifest_string(const ap_manifest_t *m, uint32_t off, uint32_t len) {
  if((uint64_t)off + len >= m->strings_size || m->strings[off + len] != 0) return NULL;
  return (const char *)m->strings + off;
}

static int
manifest_header_check(const unsigned char *h, size_t file_size, char *err,
                      size_t err_size) {
  unsigned char copy[INDEX_HEADER_SIZE];
  if(memcmp(h, INDEX_MAGIC, 8) || get_le32(h + 8) != INDEX_VERSION ||
     get_le32(h + 12) != INDEX_HEADER_SIZE || get_le32(h + 16) != 0 ||
     get_le32(h + 20) != ENDIAN_MARKER || get_le64(h + 120) != 0 ||
     get_le32(h + 60) != FILE_RECORD_SIZE ||
     get_le32(h + 64) != CHUNK_RECORD_SIZE ||
     get_le32(h + 68) != PACK_RECORD_SIZE) {
    ap_err(err, err_size, "unsupported AMPR pack index");
    return -1;
  }
  memcpy(copy, h, sizeof(copy));
  put_le32(copy + 116, 0);
  if(crc32_buf(0, copy, sizeof(copy)) != get_le32(h + 116)) {
    ap_err(err, err_size, "pack index header CRC mismatch");
    return -1;
  }
  uint64_t files = get_le64(h + 40);
  uint64_t chunks = get_le64(h + 48);
  uint64_t packs = get_le32(h + 56);
  uint64_t fo = INDEX_HEADER_SIZE;
  uint64_t co = fo + files * FILE_RECORD_SIZE;
  uint64_t po = co + chunks * CHUNK_RECORD_SIZE;
  uint64_t so = po + packs * PACK_RECORD_SIZE;
  if(files > RUNTIME_MAX_FILES * 4 || chunks > RUNTIME_MAX_CHUNKS * 4 ||
     get_le64(h + 72) != fo || get_le64(h + 80) != co ||
     get_le64(h + 88) != po || get_le64(h + 96) != so ||
     (file_size && so + get_le64(h + 104) != file_size)) {
    ap_err(err, err_size, "invalid pack index section layout");
    return -1;
  }
  return 0;
}

static int
manifest_load(ap_manifest_t *m, const char *root, int require_crc, char *err,
              size_t err_size) {
  char path[1024];
  memset(m, 0, sizeof(*m));
  if(join2(path, sizeof(path), root, AMPR_PACK_INDEX_NAME) != 0 ||
     read_file_alloc(path, &m->data, &m->size, (size_t)1 << 31) != 0) {
    ap_err(err, err_size, "read %s: %s", AMPR_PACK_INDEX_NAME, strerror(errno));
    return -1;
  }
  if(m->size < INDEX_HEADER_SIZE ||
     manifest_header_check(m->data, m->size, err, err_size) != 0) {
    ap_err(err, err_size, "pack index is truncated");
    return -1;
  }
  const unsigned char *h = m->data;
  if(crc32_buf(0, m->data + INDEX_HEADER_SIZE, m->size - INDEX_HEADER_SIZE) !=
     get_le32(h + 112)) {
    ap_err(err, err_size, "pack index payload CRC mismatch");
    return -1;
  }
  m->file_count = get_le64(h + 40);
  m->chunk_count = get_le64(h + 48);
  m->pack_count = get_le32(h + 56);
  memcpy(m->build_id, h + 24, 16);
  m->files = m->data + get_le64(h + 72);
  m->chunks = m->data + get_le64(h + 80);
  m->packs = m->data + get_le64(h + 88);
  m->strings = m->data + get_le64(h + 96);
  m->strings_size = get_le64(h + 104);

  /* CRC sidecar */
  unsigned char *crc = NULL;
  size_t crc_size = 0;
  char crc_path[1100];
  snprintf(crc_path, sizeof(crc_path), "%s.crc", path);
  if(read_file_alloc(crc_path, &crc, &crc_size, (size_t)1 << 31) == 0) {
    unsigned char hcopy[CRC_HEADER_SIZE];
    int ok = crc_size >= CRC_HEADER_SIZE && !memcmp(crc, CRC_MAGIC, 8) &&
             get_le32(crc + 8) == CRC_VERSION &&
             get_le32(crc + 12) == CRC_HEADER_SIZE &&
             !memcmp(crc + 16, m->build_id, 16) &&
             get_le64(crc + 32) == m->chunk_count &&
             crc_size == CRC_HEADER_SIZE + m->chunk_count * 4;
    if(ok) {
      memcpy(hcopy, crc, sizeof(hcopy));
      put_le32(hcopy + 44, 0);
      ok = crc32_buf(0, hcopy, sizeof(hcopy)) == get_le32(crc + 44) &&
           crc32_buf(0, crc + CRC_HEADER_SIZE, crc_size - CRC_HEADER_SIZE) ==
               get_le32(crc + 40);
    }
    if(!ok) {
      free(crc);
      ap_err(err, err_size, "chunk CRC sidecar is damaged or belongs to another build");
      return -1;
    }
    m->crcs = malloc(m->chunk_count ? m->chunk_count * 4 : 4);
    if(!m->crcs) {
      free(crc);
      ap_err(err, err_size, "out of memory");
      return -1;
    }
    for(uint64_t i = 0; i < m->chunk_count; i++) {
      m->crcs[i] = get_le32(crc + CRC_HEADER_SIZE + i * 4);
    }
    m->have_crcs = 1;
    free(crc);
  } else if(require_crc) {
    ap_err(err, err_size, "chunk CRC sidecar (%s.crc) is missing",
           AMPR_PACK_INDEX_NAME);
    return -1;
  }

  /* Pack volumes */
  m->pack_fds = malloc((m->pack_count ? m->pack_count : 1) * sizeof(int));
  m->pack_payload_begin = calloc(m->pack_count ? m->pack_count : 1, sizeof(uint64_t));
  m->pack_payload_end = calloc(m->pack_count ? m->pack_count : 1, sizeof(uint64_t));
  if(!m->pack_fds || !m->pack_payload_begin || !m->pack_payload_end) {
    ap_err(err, err_size, "out of memory");
    return -1;
  }
  for(uint32_t i = 0; i < m->pack_count; i++) m->pack_fds[i] = -1;
  for(uint32_t i = 0; i < m->pack_count; i++) {
    const unsigned char *pr = m->packs + (size_t)i * PACK_RECORD_SIZE;
    uint64_t payload = get_le64(pr);
    uint64_t fsize = get_le64(pr + 8);
    uint32_t flags = get_le32(pr + 24);
    uint32_t page = get_le32(pr + 28);
    const char *name = manifest_string(m, get_le32(pr + 16), get_le32(pr + 20));
    char ppath[1024];
    unsigned char dh[DATA_HEADER_SIZE];
    struct stat st;
    if(!name || strstr(name, "..") || name[0] == '/' ||
       (flags & ~PACK_KNOWN_FLAGS) || !(flags & PACK_FLAG_IO_PAGE_LAYOUT) ||
       page < 4096 || page > (1u << 20) || (page & (page - 1)) ||
       payload > fsize || fsize < DATA_HEADER_SIZE ||
       (fsize - payload) % page || fsize % page ||
       fsize - payload < DATA_HEADER_SIZE) {
      ap_err(err, err_size, "invalid pack record %u", i);
      return -1;
    }
    if(join2(ppath, sizeof(ppath), root, name) != 0) {
      ap_err(err, err_size, "pack path too long");
      return -1;
    }
    int fd = open(ppath, O_RDONLY);
    if(fd < 0) {
      ap_err(err, err_size, "pack volume %s is missing", name);
      return -1;
    }
    m->pack_fds[i] = fd;
    if(fstat(fd, &st) != 0 || (uint64_t)st.st_size != fsize ||
       pread_full(fd, dh, sizeof(dh), 0) != (ssize_t)sizeof(dh)) {
      ap_err(err, err_size, "pack size mismatch: %s", name);
      return -1;
    }
    unsigned char dcopy[DATA_HEADER_SIZE];
    memcpy(dcopy, dh, sizeof(dcopy));
    put_le32(dcopy + 56, 0);
    if(memcmp(dh, DATA_MAGIC, 8) || get_le32(dh + 8) != DATA_VERSION ||
       get_le32(dh + 12) != DATA_HEADER_SIZE || get_le32(dh + 16) != i ||
       get_le32(dh + 20) != flags || memcmp(dh + 24, m->build_id, 16) ||
       get_le32(dh + 60) != 0 ||
       crc32_buf(0, dcopy, sizeof(dcopy)) != get_le32(dh + 56) ||
       get_le64(dh + 48) != payload ||
       get_le64(dh + 40) + payload != fsize) {
      ap_err(err, err_size, "pack volume header mismatch: %s", name);
      return -1;
    }
    m->pack_payload_begin[i] = get_le64(dh + 40);
    m->pack_payload_end[i] = fsize;
  }
  return 0;
}

typedef struct ap_window {
  unsigned char *buf;
  uint32_t pack;
  uint64_t start;
  size_t len;
} ap_window_t;

/* One sequential read window per pack volume (direct-mapped above 16), so
 * walking files in id order streams every lane instead of thrashing. */
typedef struct ap_windows {
  ap_window_t *slots;
  uint32_t count;
  size_t bytes;
  unsigned char *scratch;
} ap_windows_t;

static int
windows_init(ap_windows_t *ws, uint32_t pack_count) {
  ws->count = pack_count == 0 ? 1 : (pack_count > 16 ? 16 : pack_count);
  ws->bytes = pack_count > 8 ? (2u << 20) : AP_WINDOW_BYTES;
  ws->slots = calloc(ws->count, sizeof(*ws->slots));
  if(!ws->slots) return -1;
  for(uint32_t i = 0; i < ws->count; i++) ws->slots[i].pack = UINT32_MAX;
  return 0;
}

static void
windows_free(ap_windows_t *ws) {
  if(ws->slots) {
    for(uint32_t i = 0; i < ws->count; i++) free(ws->slots[i].buf);
  }
  free(ws->slots);
  free(ws->scratch);
  memset(ws, 0, sizeof(*ws));
}

/* Reads and decodes one chunk into out (raw_size bytes). */
static int
read_chunk(const ap_manifest_t *m, ap_windows_t *ws, uint64_t chunk_index,
           uint32_t raw_size, unsigned char *out, char *err, size_t err_size) {
  const unsigned char *cr = m->chunks + chunk_index * CHUNK_RECORD_SIZE;
  uint64_t loc = get_le64(cr);
  uint32_t desc = get_le32(cr + 8);
  uint64_t off = loc & CHUNK_OFFSET_MASK;
  uint32_t pack = (uint32_t)(loc >> 48);
  uint32_t stored = (desc & CHUNK_STORED_MASK) + 1;
  uint32_t codec = (desc >> 20) & 3u;
  uint32_t flags = (desc >> 22) & 0xFFu;
  if(desc & 0xC0000000u || (flags & ~CHUNK_KNOWN_FLAGS) || pack >= m->pack_count ||
     off < m->pack_payload_begin[pack] ||
     off + stored > m->pack_payload_end[pack] || off % 64 ||
     (codec != CHUNK_CODEC_RAW && codec != CHUNK_CODEC_LZ4) ||
     (codec == CHUNK_CODEC_RAW && stored != raw_size)) {
    ap_err(err, err_size, "chunk %llu has an invalid descriptor",
           (unsigned long long)chunk_index);
    return -1;
  }
  ap_window_t *win = &ws->slots[pack % ws->count];
  if(!win->buf && !(win->buf = malloc(ws->bytes))) {
    ap_err(err, err_size, "out of memory");
    return -1;
  }
  const unsigned char *src;
  if(win->pack == pack && off >= win->start &&
     off + stored <= win->start + win->len) {
    src = win->buf + (off - win->start);
  } else if(win->pack == pack && off < win->start) {
    /* Deduplicated chunks point backwards: read them exactly and keep the
     * forward window where the lane is streaming. */
    if(!ws->scratch && !(ws->scratch = malloc(1u << 20))) {
      ap_err(err, err_size, "out of memory");
      return -1;
    }
    if(pread_full(m->pack_fds[pack], ws->scratch, stored, off) != (ssize_t)stored) {
      ap_err(err, err_size, "chunk %llu is truncated", (unsigned long long)chunk_index);
      return -1;
    }
    src = ws->scratch;
  } else {
    uint64_t want = ws->bytes;
    if(m->pack_payload_end[pack] - off < want) want = m->pack_payload_end[pack] - off;
    if(want < stored) want = stored;
    ssize_t n = pread_full(m->pack_fds[pack], win->buf, (size_t)want, off);
    if(n != (ssize_t)want) {
      ap_err(err, err_size, "chunk %llu is truncated", (unsigned long long)chunk_index);
      return -1;
    }
    win->pack = pack;
    win->start = off;
    win->len = (size_t)want;
    src = win->buf;
  }
  if(codec == CHUNK_CODEC_RAW) {
    memcpy(out, src, raw_size);
  } else {
    int n = LZ4_decompress_safe((const char *)src, (char *)out, (int)stored,
                                (int)raw_size);
    if(n != (int)raw_size) {
      ap_err(err, err_size, "LZ4 chunk %llu failed to decode",
             (unsigned long long)chunk_index);
      return -1;
    }
  }
  if(m->have_crcs && crc32_buf(0, out, raw_size) != m->crcs[chunk_index]) {
    ap_err(err, err_size, "chunk %llu CRC mismatch", (unsigned long long)chunk_index);
    return -1;
  }
  return 0;
}

static int
file_record_check(const ap_manifest_t *m, uint64_t file_index, char *err,
                  size_t err_size) {
  const unsigned char *fr = m->files + file_index * FILE_RECORD_SIZE;
  uint64_t size = get_le64(fr + 8);
  uint32_t first = get_le32(fr + 24);
  uint32_t count = get_le32(fr + 28);
  uint32_t flags = get_le32(fr + 40);
  uint32_t shift = fr[44];
  const char *path = manifest_string(m, get_le32(fr + 32), get_le32(fr + 36));
  if(!path || strncmp(path, "/app0/", 6) || strstr(path, "/../") ||
     fnv1a64_folded(path) != get_le64(fr) || get_le16(fr + 46) ||
     (flags & ~FILE_KNOWN_FLAGS)) {
    ap_err(err, err_size, "file record %llu is invalid",
           (unsigned long long)file_index + 1);
    return -1;
  }
  if(!(flags & FILE_FLAG_PACKED)) {
    if(first || count || shift || fr[45] || flags) {
      ap_err(err, err_size, "loose file record %llu references chunks",
             (unsigned long long)file_index + 1);
      return -1;
    }
    return 0;
  }
  if(shift < AP_MIN_BLOCK_SHIFT || shift > AP_MAX_BLOCK_SHIFT ||
     (uint64_t)first + count > m->chunk_count ||
     ((flags & FILE_FLAG_STREAMING) && (flags & FILE_FLAG_RANDOM_ACCESS))) {
    ap_err(err, err_size, "packed file record %llu is invalid",
           (unsigned long long)file_index + 1);
    return -1;
  }
  uint64_t block = 1ULL << shift;
  if((size + block - 1) / block != count) {
    ap_err(err, err_size, "logical size mismatch for file id %llu",
           (unsigned long long)file_index + 1);
    return -1;
  }
  return 0;
}

static uint32_t
chunk_raw_size(uint64_t file_size, uint32_t shift, uint32_t local) {
  uint64_t block = 1ULL << shift;
  uint64_t begin = (uint64_t)local * block;
  uint64_t rem = file_size - begin;
  return (uint32_t)(rem < block ? rem : block);
}

/* ------------------------------------------------------------- verify */

typedef struct ap_src_reader {
  int fd;
  unsigned char *buf;
  size_t len;
  size_t pos;
} ap_src_reader_t;

static int
src_read(ap_src_reader_t *r, unsigned char *out, size_t want) {
  while(want) {
    if(r->pos == r->len) {
      ssize_t n = read_full(r->fd, r->buf, AP_IO_BUFFER);
      if(n <= 0) return -1;
      r->len = (size_t)n;
      r->pos = 0;
    }
    size_t take = r->len - r->pos;
    if(take > want) take = want;
    memcpy(out, r->buf + r->pos, take);
    r->pos += take;
    out += take;
    want -= take;
  }
  return 0;
}

static int
verify_impl(const char *packed_root, const char *source_root, ap_cb_t *cb,
            ampr_pack_stats_t *st, char *err, size_t err_size) {
  ap_manifest_t m;
  ap_windows_t win = { 0 };
  unsigned char *raw = NULL;
  unsigned char *cmp = NULL;
  ap_src_reader_t sr = { -1, NULL, 0, 0 };
  int rc = -1;

  if(manifest_load(&m, packed_root, 0, err, err_size) != 0) goto done;
  raw = malloc(1u << 20);
  cmp = malloc(1u << 20);
  sr.buf = source_root ? malloc(AP_IO_BUFFER) : NULL;
  if(windows_init(&win, m.pack_count) != 0 || !raw || !cmp ||
     (source_root && !sr.buf)) {
    ap_err(err, err_size, "out of memory");
    goto done;
  }
  uint64_t total = 0, done_bytes = 0;
  for(uint64_t f = 0; f < m.file_count; f++) {
    if(file_record_check(&m, f, err, err_size) != 0) goto done;
    const unsigned char *fr = m.files + f * FILE_RECORD_SIZE;
    if(get_le32(fr + 40) & FILE_FLAG_PACKED) total += get_le64(fr + 8);
  }
  if(st) {
    st->files_total = m.file_count;
    st->chunks = m.chunk_count;
    st->pack_count = m.pack_count;
    for(int i = 0; i < 16; i++) snprintf(st->build_id + i * 2, 3, "%02x", m.build_id[i]);
  }
  cb_progress(cb, 0, total, 1);
  for(uint64_t f = 0; f < m.file_count; f++) {
    const unsigned char *fr = m.files + f * FILE_RECORD_SIZE;
    uint32_t flags = get_le32(fr + 40);
    uint64_t size = get_le64(fr + 8);
    const char *path = manifest_string(&m, get_le32(fr + 32), get_le32(fr + 36));
    const char *rel = path + 6;
    if(!(flags & FILE_FLAG_PACKED)) {
      if(st) {
        st->files_loose++;
        st->loose_bytes += size;
      }
      continue;
    }
    uint32_t first = get_le32(fr + 24);
    uint32_t count = get_le32(fr + 28);
    uint32_t shift = fr[44];
    cb_current(cb, rel);
    if(source_root) {
      char spath[1024];
      struct stat sst;
      if(join2(spath, sizeof(spath), source_root, rel) != 0 ||
         (sr.fd = open(spath, O_RDONLY)) < 0) {
        ap_err(err, err_size, "packed source is missing: %s", rel);
        goto done;
      }
      if(fstat(sr.fd, &sst) != 0 || (uint64_t)sst.st_size != size) {
        ap_err(err, err_size, "packed source size changed: %s", rel);
        goto done;
      }
      sr.len = sr.pos = 0;
    }
    for(uint32_t k = 0; k < count; k++) {
      uint32_t rs = chunk_raw_size(size, shift, k);
      uint32_t desc = get_le32(m.chunks + ((uint64_t)first + k) * CHUNK_RECORD_SIZE + 8);
      int streaming = (desc >> 22) & CHUNK_FLAG_STREAMING;
      if(!!streaming != !!(flags & FILE_FLAG_STREAMING) ||
         ((flags & FILE_FLAG_STORE_ONLY) && ((desc >> 20) & 3u) != CHUNK_CODEC_RAW) ||
         (desc & CHUNK_STORED_MASK) + 1 > (1u << shift)) {
        ap_err(err, err_size, "chunk flags mismatch for %s", rel);
        goto done;
      }
      {
        uint64_t loc = get_le64(m.chunks + ((uint64_t)first + k) * CHUNK_RECORD_SIZE);
        uint32_t pack = (uint32_t)(loc >> 48);
        uint64_t off = loc & CHUNK_OFFSET_MASK;
        uint32_t stored = (desc & CHUNK_STORED_MASK) + 1;
        uint32_t cflags = (desc >> 22) & 0xFFu;
        uint32_t page = pack < m.pack_count
            ? get_le32(m.packs + (size_t)pack * PACK_RECORD_SIZE + 28) : 0;
        int contained = (cflags & CHUNK_FLAG_PAGE_CONTAINED) != 0;
        int aligned = (cflags & CHUNK_FLAG_PAGE_ALIGNED) != 0;
        if(!page ||
           (contained && (stored > page || off / page != (off + stored - 1) / page)) ||
           (aligned && off % page) ||
           (stored <= page && aligned && !contained) ||
           (!(flags & FILE_FLAG_STREAMING) && !contained && !aligned)) {
          ap_err(err, err_size, "chunk placement is not page-safe for %s", rel);
          goto done;
        }
      }
      if(read_chunk(&m, &win, (uint64_t)first + k, rs, raw, err, err_size) != 0) {
        ap_err(err, err_size, "%s", rel);
        goto done;
      }
      if(source_root) {
        if(src_read(&sr, cmp, rs) != 0) {
          ap_err(err, err_size, "packed source was truncated: %s", rel);
          goto done;
        }
        if(memcmp(raw, cmp, rs)) {
          ap_err(err, err_size, "packed data differs from the original: %s", rel);
          goto done;
        }
      }
      done_bytes += rs;
      cb_progress(cb, done_bytes, total, 0);
      if((k & 255) == 0 && cb_cancelled(cb)) {
        ap_err(err, err_size, "cancelled");
        goto done;
      }
    }
    if(source_root) {
      unsigned char extra;
      if(sr.pos != sr.len || read(sr.fd, &extra, 1) != 0) {
        ap_err(err, err_size, "packed source has extra bytes: %s", rel);
        goto done;
      }
      close(sr.fd);
      sr.fd = -1;
    }
    if(st) {
      st->files_packed++;
      st->logical_bytes += size;
    }
  }
  if(st) {
    for(uint32_t i = 0; i < m.pack_count; i++) {
      st->pack_bytes += get_le64(m.packs + (size_t)i * PACK_RECORD_SIZE + 8);
    }
    st->manifest_bytes = m.size;
  }
  cb_progress(cb, total, total, 1);
  rc = 0;

done:
  if(sr.fd >= 0) close(sr.fd);
  free(sr.buf);
  windows_free(&win);
  free(raw);
  free(cmp);
  manifest_free(&m);
  return rc;
}

int
ampr_pack_verify(const char *packed_root, const char *source_root,
                 const ampr_pack_callbacks_t *cb, ampr_pack_stats_t *stats,
                 char *err, size_t err_size) {
  ap_cb_t c = { cb, 0 };
  if(stats) memset(stats, 0, sizeof(*stats));
  cb_phase(&c, "lz4-verify", source_root ? "Comparing packs with the original files"
                                         : "Verifying LZ4 packs");
  return verify_impl(packed_root, source_root, &c, stats, err, err_size);
}

/* ------------------------------------------------------------- copy */

static int
copy_file(const char *src, const char *dst, const struct stat *sst,
          unsigned char *buf, int verify, uint64_t *copied, ap_cb_t *cb,
          uint64_t *done, uint64_t total, char *err, size_t err_size) {
  int in = open(src, O_RDONLY);
  if(in < 0) {
    ap_err(err, err_size, "open %s: %s", src, strerror(errno));
    return -1;
  }
  /* Always 0777: a copy from an .exfat image comes in as 0666, and a
   * non-executable eboot.bin or module crashes the game (SIGBUS). */
  (void)sst;
  int out = open(dst, O_WRONLY | O_CREAT | O_EXCL, 0777);
  if(out < 0) {
    ap_err(err, err_size, "create %s: %s", dst, strerror(errno));
    close(in);
    return -1;
  }
  (void)fchmod(out, 0777);
  uint32_t crc = 0;
  uint64_t n_total = 0;
  for(;;) {
    ssize_t n = read_full(in, buf, AP_IO_BUFFER);
    if(n < 0) {
      ap_err(err, err_size, "read %s: %s", src, strerror(errno));
      goto fail;
    }
    if(n == 0) break;
    if(write_all(out, buf, (size_t)n) != 0) {
      ap_err(err, err_size, "write %s: %s", dst, strerror(errno));
      goto fail;
    }
    if(verify) crc = crc32_buf(crc, buf, (size_t)n);
    n_total += (uint64_t)n;
    *done += (uint64_t)n;
    cb_progress(cb, *done, total, 0);
    if(cb_cancelled(cb)) {
      ap_err(err, err_size, "cancelled");
      goto fail;
    }
  }
  if(n_total != (uint64_t)sst->st_size) {
    ap_err(err, err_size, "source changed while copying: %s", src);
    goto fail;
  }
  if(fsync(out) != 0 || close(out) != 0) {
    out = -1;
    ap_err(err, err_size, "write %s: %s", dst, strerror(errno));
    goto fail;
  }
  out = -1;
  close(in);
  in = -1;
  if(verify) {
    int v = open(dst, O_RDONLY);
    uint32_t vcrc = 0;
    uint64_t vn = 0;
    if(v < 0) {
      ap_err(err, err_size, "reopen %s: %s", dst, strerror(errno));
      return -1;
    }
    for(;;) {
      ssize_t n = read_full(v, buf, AP_IO_BUFFER);
      if(n < 0) {
        close(v);
        ap_err(err, err_size, "read back %s: %s", dst, strerror(errno));
        return -1;
      }
      if(n == 0) break;
      vcrc = crc32_buf(vcrc, buf, (size_t)n);
      vn += (uint64_t)n;
    }
    close(v);
    if(vcrc != crc || vn != n_total) {
      ap_err(err, err_size, "copied file does not match the original: %s", dst);
      return -1;
    }
  }
  struct timeval tv[2];
  tv[0].tv_sec = sst->st_atime;
  tv[0].tv_usec = 0;
  tv[1].tv_sec = sst->st_mtime;
  tv[1].tv_usec = 0;
  (void)utimes(dst, tv);
  if(copied) *copied += n_total;
  return 0;

fail:
  if(out >= 0) close(out);
  if(in >= 0) close(in);
  unlink(dst);
  return -1;
}

static int
copy_loose(ap_ctx_t *c) {
  uint64_t total = 0, done = 0;
  unsigned char *buf = malloc(AP_IO_BUFFER);
  if(!buf) {
    ctx_err(c, "out of memory");
    return -1;
  }
  for(size_t i = 0; i < c->item_count; i++) {
    if(c->items[i].action == AP_ACTION_LOOSE) total += c->items[i].size;
  }
  cb_phase(&c->cb, "lz4-copy", "Copying loose files");
  cb_progress(&c->cb, 0, total, 1);
  for(size_t i = 0; i < c->item_count; i++) {
    const ap_item_t *it = &c->items[i];
    char src[1024], dst[1024];
    struct stat sst, dst_st;
    if(it->action != AP_ACTION_LOOSE) continue;
    if(join2(src, sizeof(src), c->src, it->rel) != 0 ||
       join2(dst, sizeof(dst), c->out, it->rel) != 0) {
      free(buf);
      ctx_err(c, "path too long: %s", it->rel);
      return -1;
    }
    if(lstat(dst, &dst_st) == 0) {
      done += it->size;
      continue; /* the installed runtime */
    }
    if(lstat(src, &sst) != 0 || !S_ISREG(sst.st_mode)) {
      free(buf);
      ctx_err(c, "loose source is missing: %s", it->rel);
      return -1;
    }
    cb_current(&c->cb, it->rel);
    if(mkdirs_parent(dst) != 0 ||
       copy_file(src, dst, &sst, buf, c->o->verify_loose_copies, NULL, &c->cb,
                 &done, total, c->err, c->err_size) != 0) {
      free(buf);
      ctx_err(c, "copy %s failed", it->rel);
      return -1;
    }
  }
  free(buf);
  cb_progress(&c->cb, total, total, 1);
  return 0;
}

/* --------------------------------------------------------- in place */

static int
removal_protected(const char *rel) {
  static const char *const dirs[] = { "mods", "save", "sce_module", "sce_sys", "system" };
  static const char *const names[] = {
    "ampr_assets.index", "ampr_assets.index.crc", "ampr_assets.index.runtime",
    "ampr_emu.index", "eboot.bin", "nptitle.dat", "param.sfo",
  };
  static const char *const suffixes[] = { ".elf", ".prx", ".self", ".sprx" };
  const char *slash = strchr(rel, '/');
  size_t top = slash ? (size_t)(slash - rel) : strlen(rel);
  for(size_t i = 0; i < sizeof(dirs) / sizeof(dirs[0]); i++) {
    if(slash && strlen(dirs[i]) == top && !strncasecmp(rel, dirs[i], top)) return 1;
  }
  const char *name = strrchr(rel, '/');
  name = name ? name + 1 : rel;
  for(size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    if(!strcasecmp(name, names[i])) return 1;
  }
  const char *dot = strrchr(name, '.');
  if(dot && dot != name) {
    for(size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); i++) {
      if(!strcasecmp(dot, suffixes[i])) return 1;
    }
  }
  size_t nl = strlen(name);
  if(nl > 16 && !strncasecmp(name, "ampr_assets-", 12) &&
     !strcasecmp(name + nl - 4, ".pak")) {
    return 1;
  }
  return 0;
}

static int
remove_packed_sources(ap_ctx_t *c) {
  uint64_t total = 0, done = 0;
  for(size_t i = 0; i < c->item_count; i++) {
    const ap_item_t *it = &c->items[i];
    if(it->action == AP_ACTION_LOOSE) continue;
    if(removal_protected(it->rel)) {
      ctx_err(c, "refusing to remove protected file %s", it->rel);
      return -1;
    }
    total += it->size;
  }
  cb_phase(&c->cb, "lz4-remove", "Removing originals stored in packs");
  for(size_t i = 0; i < c->item_count; i++) {
    const ap_item_t *it = &c->items[i];
    char path[1024];
    struct stat st;
    if(it->action == AP_ACTION_LOOSE) continue;
    if(join2(path, sizeof(path), c->src, it->rel) != 0) {
      ctx_err(c, "path too long: %s", it->rel);
      return -1;
    }
    if(lstat(path, &st) != 0) continue;
    if(!S_ISREG(st.st_mode) || (uint64_t)st.st_size != it->size) {
      ctx_err(c, "packed source changed: %s", it->rel);
      return -1;
    }
    if(unlink(path) != 0) {
      ctx_err(c, "remove %s: %s", it->rel, strerror(errno));
      return -1;
    }
    done += it->size;
    c->st->removed_bytes += it->size;
    cb_progress(&c->cb, done, total, 0);
  }
  cb_progress(&c->cb, total, total, 1);
  return 0;
}

static void
rollback_in_place(ap_ctx_t *c) {
  char path[1024];
  unlink_published(c);
  if(c->index_written && join2(path, sizeof(path), c->src, "ampr_emu.index") == 0) {
    if(c->had_index) {
      (void)write_file_atomic(path, c->backup_index, c->backup_index_size, 0777);
    } else {
      unlink(path);
    }
  }
  if(c->runtime_replaced && join2(path, sizeof(path), c->src, c->runtime_rel) == 0) {
    (void)write_file_atomic(path, c->backup_runtime, c->backup_runtime_size, 0777);
  }
  if(c->runtime_created && join2(path, sizeof(path), c->src, c->runtime_rel) == 0) {
    unlink(path);
  }
}

/* -------------------------------------------------------------- build */

static void
ctx_free(ap_ctx_t *c) {
  pool_stop(&c->pool);
  if(c->slots) {
    for(size_t i = 0; i < c->slot_count; i++) {
      free(c->slots[i].raw);
      free(c->slots[i].out);
    }
    free(c->slots);
  }
  for(size_t i = 0; i < c->writer_count; i++) {
    writer_abort(c->writers[i]);
    free(c->writers[i]);
  }
  free(c->writers);
  if(c->current) {
    for(size_t g = 0; g < c->cfg.group_count; g++) free(c->current[g]);
    free(c->current);
  }
  if(c->volume_numbers) {
    for(size_t g = 0; g < c->cfg.group_count; g++) free(c->volume_numbers[g]);
    free(c->volume_numbers);
  }
  free(c->dd.slots);
  free(c->chunk_loc);
  free(c->chunk_desc);
  free(c->chunk_crc);
  free(c->items);
  free(c->idx);
  free(c->backup_index);
  free(c->backup_runtime);
  scan_free(&c->scan);
  ap_config_free(&c->cfg);
}

static int
default_workers(void) {
  long n = sysconf(_SC_NPROCESSORS_ONLN);
  if(n <= 0) n = 8;
  n -= 1;
  if(n < 1) n = 1;
  if(n > 16) n = 16;
  return (int)n;
}

/* The game imports libSceAmpr but ships no APR-EMU: add the runtime as a new
 * loose file (next to any fakelib folder the game already has) and index it. */
static int
create_runtime(ap_ctx_t *c) {
  const ampr_pack_options_t *o = c->o;
  const char *dir = "fakelib";
  char rel[512];
  char path[1024];
  struct stat st;
  for(size_t i = 0; i < c->scan.dirs.count; i++) {
    if(!strcasecmp(c->scan.dirs.items[i], "fakelib")) dir = c->scan.dirs.items[i];
  }
  snprintf(rel, sizeof(rel), "%s/libSceAmpr.sprx", dir);
  if(join2(path, sizeof(path), c->in_place ? c->src : c->out, rel) != 0) {
    ctx_err(c, "path too long: %s", rel);
    return -1;
  }
  if(mkdirs_parent(path) != 0 ||
     write_file_atomic(path, o->runtime, o->runtime_size, 0777) != 0 ||
     stat(path, &st) != 0) {
    ctx_err(c, "install LZ4 runtime: %s", strerror(errno));
    return -1;
  }
  snprintf(c->runtime_rel, sizeof(c->runtime_rel), "%s", rel);
  c->runtime_created = c->in_place;
  if(scan_add_file(&c->scan, rel, &st) != 0) {
    ctx_err(c, "out of memory");
    return -1;
  }
  c->st->runtime_installed = 1;
  cb_log(&c->cb, "added PackedStdio runtime at %s", rel);
  return 0;
}

static int
install_runtime(ap_ctx_t *c) {
  ap_scan_file_t *rf = scan_find_ci(&c->scan, AMPR_PACK_RUNTIME_REL);
  const ampr_pack_options_t *o = c->o;
  char path[1024];
  struct stat st;
  if(!o->runtime || !o->runtime_size) return 0;
  if(!rf) return o->install_runtime_if_missing ? create_runtime(c) : 0;
  snprintf(c->runtime_rel, sizeof(c->runtime_rel), "%s", rf->rel);
  if(c->in_place) {
    if(join2(path, sizeof(path), c->src, rf->rel) != 0 ||
       read_file_alloc(path, &c->backup_runtime, &c->backup_runtime_size,
                       64 * MIB) != 0) {
      ctx_err(c, "read %s: %s", rf->rel, strerror(errno));
      return -1;
    }
    if(c->backup_runtime_size == o->runtime_size &&
       !memcmp(c->backup_runtime, o->runtime, o->runtime_size)) {
      c->st->runtime_installed = 1;
      return 0;
    }
  } else if(join2(path, sizeof(path), c->out, rf->rel) != 0) {
    ctx_err(c, "path too long: %s", rf->rel);
    return -1;
  }
  if(mkdirs_parent(path) != 0 ||
     write_file_atomic(path, o->runtime, o->runtime_size, 0777) != 0 ||
     stat(path, &st) != 0) {
    ctx_err(c, "install LZ4 runtime: %s", strerror(errno));
    return -1;
  }
  c->runtime_replaced = c->in_place;
  /* The index describes the deployed runtime, not the replaced one. */
  rf->size = (uint64_t)st.st_size;
  rf->mtime = (int64_t)st.st_mtime;
  c->st->runtime_installed = 1;
  cb_log(&c->cb, "installed PackedStdio runtime at %s", rf->rel);
  return 0;
}

/* Case-insensitive entry lookup in dir; 0 and the real name in out if found. */
static int
find_entry_ci(const char *dir, const char *name, char *out, size_t out_size) {
  DIR *d = opendir(dir);
  struct dirent *ent;
  int rc = -1;
  if(!d) return -1;
  while((ent = readdir(d)) != NULL) {
    if(strcasecmp(ent->d_name, name)) continue;
    snprintf(out, out_size, "%s", ent->d_name);
    rc = 0;
    if(!strcmp(ent->d_name, name)) break;
  }
  closedir(d);
  return rc;
}

int
ampr_pack_check_runtime(const char *root, int repair, char old_sha[65],
                        char *err, size_t err_size) {
  size_t want_size = 0;
  const unsigned char *want = ampr_pack_runtime_data(&want_size);
  char dir_name[256] = "fakelib";
  char file_name[256] = "libSceAmpr.sprx";
  char dir[1024];
  char path[1280];
  unsigned char *have = NULL;
  size_t have_size = 0;
  int found = 0;

  if(old_sha) old_sha[0] = 0;
  if(err && err_size) err[0] = 0;
  if(!want || !want_size) return 0;
  (void)find_entry_ci(root, "fakelib", dir_name, sizeof(dir_name));
  snprintf(dir, sizeof(dir), "%s/%s", root, dir_name);
  if(find_entry_ci(dir, "libSceAmpr.sprx", file_name, sizeof(file_name)) == 0) {
    found = 1;
  }
  snprintf(path, sizeof(path), "%s/%s", dir, file_name);
  if(found) {
    if(read_file_alloc(path, &have, &have_size, 64 * MIB) != 0) {
      snprintf(err, err_size, "read %s/%s: %s", dir_name, file_name,
               strerror(errno));
      return -1;
    }
    if(have_size == want_size && !memcmp(have, want, want_size)) {
      free(have);
      return 0;
    }
    if(old_sha) {
      ap_sha256_t s;
      unsigned char d[32];
      sha256_init(&s);
      sha256_update(&s, have, have_size);
      sha256_final(&s, d);
      for(int i = 0; i < 32; i++) snprintf(old_sha + i * 2, 3, "%02x", d[i]);
    }
    free(have);
  }
  if(!repair) return 1;
  if(mkdirs_parent(path) != 0 ||
     write_file_atomic(path, want, want_size, 0777) != 0) {
    snprintf(err, err_size, "install LZ4 runtime: %s", strerror(errno));
    return -1;
  }
  (void)chmod(path, 0777);
  return 1;
}

static int
write_index(ap_ctx_t *c) {
  char path[1024];
  if(join2(path, sizeof(path), c->out, "ampr_emu.index") != 0) {
    ctx_err(c, "path too long");
    return -1;
  }
  if(c->in_place) {
    struct stat st;
    if(lstat(path, &st) == 0) {
      if(read_file_alloc(path, &c->backup_index, &c->backup_index_size,
                         512 * MIB) != 0) {
        ctx_err(c, "read ampr_emu.index: %s", strerror(errno));
        return -1;
      }
      c->had_index = 1;
    }
  }
  if(write_file_atomic(path, c->idx, c->idx_size, 0777) != 0) {
    ctx_err(c, "write ampr_emu.index: %s", strerror(errno));
    return -1;
  }
  c->index_written = 1;
  return 0;
}

static int
setup_pipeline(ap_ctx_t *c, int workers) {
  int max_shift = c->cfg.default_block_shift;
  for(size_t i = 0; i < c->cfg.rule_count; i++) {
    if(c->cfg.rules[i].block_shift > max_shift) max_shift = c->cfg.rules[i].block_shift;
  }
  uint32_t max_block = 1u << max_shift;
  c->slot_count = (size_t)workers * 4;
  if(c->slot_count < 16) c->slot_count = 16;
  if(max_shift >= 19 && c->slot_count > 32) c->slot_count = 32;
  c->slots = calloc(c->slot_count, sizeof(*c->slots));
  if(!c->slots) return -1;
  for(size_t i = 0; i < c->slot_count; i++) {
    ap_slot_t *s = &c->slots[i];
    s->raw_cap = max_block;
    s->out_cap = (uint32_t)LZ4_compressBound((int)max_block);
    s->raw = malloc(s->raw_cap);
    s->out = malloc(s->out_cap);
    if(!s->raw || !s->out) return -1;
  }
  if(pool_start(&c->pool, workers, c->slot_count) != 0) return -1;
  c->current = calloc(c->cfg.group_count, sizeof(*c->current));
  c->volume_numbers = calloc(c->cfg.group_count, sizeof(*c->volume_numbers));
  if(!c->current || !c->volume_numbers) return -1;
  for(size_t g = 0; g < c->cfg.group_count; g++) {
    uint32_t lanes = c->cfg.groups[g].pack_count;
    c->current[g] = malloc(lanes * sizeof(int32_t));
    c->volume_numbers[g] = calloc(lanes, sizeof(uint32_t));
    if(!c->current[g] || !c->volume_numbers[g]) return -1;
    for(uint32_t l = 0; l < lanes; l++) c->current[g][l] = -1;
  }
  return 0;
}

int
ampr_pack_build(const ampr_pack_options_t *o, ampr_pack_stats_t *stats,
                char *err, size_t err_size) {
  ap_ctx_t c;
  struct stat st;
  int rc = -1;
  int removal_started = 0;

  memset(&c, 0, sizeof(c));
  if(stats) memset(stats, 0, sizeof(*stats));
  ampr_pack_stats_t local;
  memset(&local, 0, sizeof(local));
  c.o = o;
  c.st = stats ? stats : &local;
  c.err = err;
  c.err_size = err_size;
  c.cb.cb = &o->cb;
  c.src = o->source_root;
  c.in_place = o->mode == AMPR_PACK_MODE_IN_PLACE;
  c.out = c.in_place ? o->source_root : o->output_root;
  if(err && err_size) err[0] = 0;

  if(!c.src || !c.out || stat(c.src, &st) != 0 || !S_ISDIR(st.st_mode) ||
     stat(c.out, &st) != 0 || !S_ISDIR(st.st_mode)) {
    ctx_err(&c, "game folder or output folder is unavailable");
    return -1;
  }
  if(ampr_pack_tree_has_manifest(c.src)) {
    ctx_err(&c, "this game is already LZ4 packed");
    return -1;
  }
  if(!c.in_place && ampr_pack_tree_has_manifest(c.out)) {
    ctx_err(&c, "output already contains an LZ4 pack set");
    return -1;
  }
  int workers = o->workers > 0 ? o->workers : default_workers();
  int level = o->level > 0 ? o->level : 9;
  int block_shift = o->block_shift ? o->block_shift : 16;
  if(level > 12) level = 12;
  if(block_shift < AP_MIN_BLOCK_SHIFT || block_shift > AP_MAX_BLOCK_SHIFT) {
    ctx_err(&c, "block size must be between 16 KiB and 1 MiB");
    return -1;
  }
  c.st->workers = (uint32_t)workers;
  c.st->level = level;

  /* 1. Scan the source tree. */
  cb_phase(&c.cb, "lz4-scan", "Scanning game files");
  if(scan_walk(c.src, "", &c.scan, &c.cb, c.err, c.err_size) != 0) goto done;
  if(!c.in_place) {
    for(size_t i = 0; i < c.scan.dirs.count; i++) {
      char d[1024];
      if(join2(d, sizeof(d), c.out, c.scan.dirs.items[i]) != 0 ||
         mkdirs_p(d, 0777) != 0) {
        ctx_err(&c, "create folder %s: %s", c.scan.dirs.items[i], strerror(errno));
        goto done;
      }
    }
  }

  /* 2. Runtime, then the AMPRIDX3 that describes the deployed tree. */
  if(install_runtime(&c) != 0) goto rollback;
  cb_phase(&c.cb, "lz4-index", "Building AMPR index");
  if(build_index(&c) != 0 || write_index(&c) != 0) goto rollback;

  /* 3. Profile. */
  ap_config_init_defaults(&c.cfg);
  if(o->profile_path && o->profile_path[0]) {
    /* The chosen level and worker count also apply to custom profiles. */
    if(ap_config_load_toml(&c.cfg, o->profile_path, level, workers, c.err,
                           c.err_size) != 0) {
      goto rollback;
    }
  } else if(ap_config_build_universal(&c.cfg, &c.scan, level, block_shift,
                                      workers, o->auto_loose_large,
                                      o->learn_dir, c.err, c.err_size) != 0) {
    goto rollback;
  }
  if(ap_config_add_safety_exclusions(&c.cfg) != 0 ||
     ap_config_finalize(&c.cfg, c.err, c.err_size) != 0) {
    ctx_err(&c, "invalid pack profile");
    goto rollback;
  }
  snprintf(c.st->profile, sizeof(c.st->profile), "%s", c.cfg.source);
  c.st->learned_patterns = c.cfg.learned_patterns;
  if(join2(c.index_path, sizeof(c.index_path), c.out, c.cfg.index_name) != 0) {
    ctx_err(&c, "path too long");
    goto rollback;
  }
  snprintf(c.crc_path, sizeof(c.crc_path), "%s.crc", c.index_path);
  snprintf(c.runtime_path, sizeof(c.runtime_path), "%s.runtime", c.index_path);
  if(setup_pipeline(&c, workers) != 0) {
    ctx_err(&c, "could not start compression workers");
    goto rollback;
  }

  /* 4. Plan, pack, finalize, publish. */
  if(plan_files(&c) != 0) goto rollback;
  if(pack_files(&c) != 0) goto rollback;
  cb_phase(&c.cb, "lz4-finalize", "Writing pack manifest");
  compute_build_id(&c);
  if(finalize_volumes(&c) != 0 || write_manifest_files(&c) != 0 ||
     publish(&c) != 0) {
    goto rollback;
  }
  c.st->files_total = c.item_count;
  for(size_t i = 0; i < c.item_count; i++) {
    if(c.items[i].action == AP_ACTION_LOOSE) {
      c.st->files_loose++;
      c.st->loose_bytes += c.items[i].size;
    }
  }
  cb_log(&c.cb, "packed files=%llu loose=%llu chunks=%llu lz4=%llu raw=%llu shared=%llu logical=%llu stored=%llu packs=%u",
         (unsigned long long)c.st->files_packed,
         (unsigned long long)c.st->files_loose,
         (unsigned long long)c.st->chunks,
         (unsigned long long)c.st->chunks_lz4,
         (unsigned long long)c.st->chunks_raw,
         (unsigned long long)c.st->chunks_shared,
         (unsigned long long)c.st->logical_bytes,
         (unsigned long long)c.st->stored_bytes, c.st->pack_count);
  pool_stop(&c.pool);

  /* 5. Verify every packed file against its source. */
  {
    ampr_pack_stats_t vst;
    memset(&vst, 0, sizeof(vst));
    cb_phase(&c.cb, "lz4-verify", "Comparing packs with the original files");
    if(verify_impl(c.out, c.src, &c.cb, &vst, c.err, c.err_size) != 0) {
      ctx_err(&c, "pack verification failed");
      goto rollback;
    }
    if(vst.files_packed != c.st->files_packed ||
       vst.logical_bytes != c.st->logical_bytes) {
      ctx_err(&c, "pack verification counted a different set of files");
      goto rollback;
    }
  }

  /* 6. Loose files (copy) or removal of packed originals (in place). */
  if(c.in_place) {
    removal_started = 1;
    if(remove_packed_sources(&c) != 0) goto done;
  } else if(copy_loose(&c) != 0) {
    goto done;
  }
  rc = 0;
  goto done;

rollback:
  if(c.in_place && !removal_started) rollback_in_place(&c);
  else unlink_published(&c);
done:
  ctx_free(&c);
  return rc;
}

/* ------------------------------------------------------------- unpack */

static int
is_pack_artifact(const ap_manifest_t *m, const char *rel) {
  if(!strcmp(rel, AMPR_PACK_INDEX_NAME) ||
     !strcmp(rel, AMPR_PACK_INDEX_NAME ".crc") ||
     !strcmp(rel, AMPR_PACK_INDEX_NAME ".runtime")) {
    return 1;
  }
  for(uint32_t i = 0; i < m->pack_count; i++) {
    const unsigned char *pr = m->packs + (size_t)i * PACK_RECORD_SIZE;
    const char *name = manifest_string(m, get_le32(pr + 16), get_le32(pr + 20));
    if(name && !strcmp(name, rel)) return 1;
  }
  size_t n = strlen(rel);
  return n > 4 && strstr(rel, ".lzc-lz4") && !strcmp(rel + n - 4, ".tmp");
}

static int
unpack_extra_files(const ap_manifest_t *m, const char *root, const char *out,
                   const char *rel, unsigned char *buf, ap_cb_t *cb,
                   uint64_t *done, uint64_t total, char *err, size_t err_size) {
  char path[1024];
  if(rel[0]) {
    if(join2(path, sizeof(path), root, rel) != 0) return -1;
  } else {
    snprintf(path, sizeof(path), "%s", root);
  }
  DIR *d = opendir(path);
  if(!d) {
    ap_err(err, err_size, "open %s: %s", path, strerror(errno));
    return -1;
  }
  struct dirent *ent;
  int rc = 0;
  while(rc == 0 && (ent = readdir(d)) != NULL) {
    char crel[1024], src[1024], dst[1024];
    struct stat st, dst_st;
    if(!strcmp(ent->d_name, ".") || !strcmp(ent->d_name, "..")) continue;
    if(rel[0]) snprintf(crel, sizeof(crel), "%s/%s", rel, ent->d_name);
    else snprintf(crel, sizeof(crel), "%s", ent->d_name);
    if(join2(src, sizeof(src), root, crel) != 0 ||
       join2(dst, sizeof(dst), out, crel) != 0 || lstat(src, &st) != 0) {
      rc = -1;
      break;
    }
    if(S_ISDIR(st.st_mode)) {
      if(mkdirs_p(dst, 0777) != 0) {
        ap_err(err, err_size, "create %s: %s", crel, strerror(errno));
        rc = -1;
        break;
      }
      rc = unpack_extra_files(m, root, out, crel, buf, cb, done, total, err,
                              err_size);
      continue;
    }
    if(!S_ISREG(st.st_mode) || is_pack_artifact(m, crel)) continue;
    if(lstat(dst, &dst_st) == 0) continue;
    cb_current(cb, crel);
    if(mkdirs_parent(dst) != 0 ||
       copy_file(src, dst, &st, buf, 0, NULL, cb, done, total, err,
                 err_size) != 0) {
      rc = -1;
    }
  }
  closedir(d);
  return rc;
}

/* Removes folders that only held pack volumes (pack_pattern subfolders). */
static void
remove_pack_dirs(const ap_manifest_t *m, const char *root) {
  for(uint32_t i = 0; i < m->pack_count; i++) {
    const unsigned char *pr = m->packs + (size_t)i * PACK_RECORD_SIZE;
    const char *name = manifest_string(m, get_le32(pr + 16), get_le32(pr + 20));
    char dir[1024];
    if(!name || !strchr(name, '/') || join2(dir, sizeof(dir), root, name) != 0) {
      continue;
    }
    size_t root_len = strlen(root);
    for(;;) {
      char *slash = strrchr(dir, '/');
      if(!slash || (size_t)(slash - dir) <= root_len) break;
      *slash = 0;
      if(rmdir(dir) != 0) break;
    }
  }
}

int
ampr_pack_unpack(const char *packed_root, const char *output_root,
                 const ampr_pack_callbacks_t *cb, ampr_pack_stats_t *stats,
                 char *err, size_t err_size) {
  ap_cb_t c = { cb, 0 };
  ap_manifest_t m;
  ap_windows_t win = { 0 };
  unsigned char *raw = malloc(1u << 20);
  unsigned char *buf = malloc(AP_IO_BUFFER);
  int in_place = output_root == NULL;
  const char *out = in_place ? packed_root : output_root;
  int rc = -1;
  uint64_t total = 0, done = 0;
  ampr_pack_stats_t local;
  ampr_pack_stats_t *st = stats ? stats : &local;
  memset(st, 0, sizeof(*st));
  memset(&m, 0, sizeof(m));
  if(!raw || !buf) {
    ap_err(err, err_size, "out of memory");
    goto done;
  }
  cb_phase(&c, "lz4-unpack", "Restoring files from LZ4 packs");
  if(manifest_load(&m, packed_root, 0, err, err_size) != 0) goto done;
  if(windows_init(&win, m.pack_count) != 0) {
    ap_err(err, err_size, "out of memory");
    goto done;
  }
  for(uint64_t f = 0; f < m.file_count; f++) {
    if(file_record_check(&m, f, err, err_size) != 0) goto done;
    total += get_le64(m.files + f * FILE_RECORD_SIZE + 8);
  }
  st->files_total = m.file_count;
  cb_progress(&c, 0, total, 1);
  for(uint64_t f = 0; f < m.file_count; f++) {
    const unsigned char *fr = m.files + f * FILE_RECORD_SIZE;
    uint64_t size = get_le64(fr + 8);
    uint32_t flags = get_le32(fr + 40);
    const char *rel = manifest_string(&m, get_le32(fr + 32), get_le32(fr + 36)) + 6;
    char dst[1024], tmp[1100];
    if(join2(dst, sizeof(dst), out, rel) != 0) {
      ap_err(err, err_size, "path too long: %s", rel);
      goto done;
    }
    cb_current(&c, rel);
    if(!(flags & FILE_FLAG_PACKED)) {
      if(!in_place) {
        char src[1024];
        struct stat sst, dst_st;
        if(join2(src, sizeof(src), packed_root, rel) != 0 ||
           lstat(src, &sst) != 0 || !S_ISREG(sst.st_mode)) {
          ap_err(err, err_size, "loose file is missing: %s", rel);
          goto done;
        }
        if(lstat(dst, &dst_st) != 0 &&
           (mkdirs_parent(dst) != 0 ||
            copy_file(src, dst, &sst, buf, 0, NULL, &c, &done, total, err,
                      err_size) != 0)) {
          goto done;
        }
      } else {
        done += size;
      }
      st->files_loose++;
      st->loose_bytes += size;
      continue;
    }
    uint32_t first = get_le32(fr + 24);
    uint32_t count = get_le32(fr + 28);
    uint32_t shift = fr[44];
    if(mkdirs_parent(dst) != 0) {
      ap_err(err, err_size, "create folder for %s: %s", rel, strerror(errno));
      goto done;
    }
    snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", dst);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
    if(fd < 0) {
      ap_err(err, err_size, "create %s: %s", rel, strerror(errno));
      goto done;
    }
    (void)fchmod(fd, 0777);
    /* Decode into a large buffer: small writes are slow on the PS5's /data. */
    size_t buffered = 0;
    for(uint32_t k = 0; k < count; k++) {
      uint32_t rs = chunk_raw_size(size, shift, k);
      if(buffered + rs > AP_IO_BUFFER) {
        if(write_all(fd, buf, buffered) != 0) {
          ap_err(err, err_size, "restore %s: %s", rel, strerror(errno));
          close(fd);
          unlink(tmp);
          goto done;
        }
        buffered = 0;
      }
      if(read_chunk(&m, &win, (uint64_t)first + k, rs, buf + buffered, err,
                    err_size) != 0) {
        ap_err(err, err_size, "restore %s", rel);
        close(fd);
        unlink(tmp);
        goto done;
      }
      buffered += rs;
      done += rs;
      cb_progress(&c, done, total, 0);
      if((k & 255) == 0 && cb_cancelled(&c)) {
        ap_err(err, err_size, "cancelled");
        close(fd);
        unlink(tmp);
        goto done;
      }
    }
    if(buffered && write_all(fd, buf, buffered) != 0) {
      ap_err(err, err_size, "restore %s: %s", rel, strerror(errno));
      close(fd);
      unlink(tmp);
      goto done;
    }
    if(fsync(fd) != 0 || close(fd) != 0 || rename(tmp, dst) != 0) {
      ap_err(err, err_size, "restore %s: %s", rel, strerror(errno));
      unlink(tmp);
      goto done;
    }
    struct timeval tv[2];
    tv[0].tv_sec = tv[1].tv_sec = (time_t)get_le64(fr + 16);
    tv[0].tv_usec = tv[1].tv_usec = 0;
    (void)utimes(dst, tv);
    st->files_packed++;
    st->logical_bytes += size;
  }
  if(!in_place) {
    if(unpack_extra_files(&m, packed_root, out, "", buf, &c, &done, total, err,
                          err_size) != 0) {
      goto done;
    }
    remove_pack_dirs(&m, out);
  }
  if(in_place) {
    char path[1024];
    for(uint32_t i = 0; i < m.pack_count; i++) {
      const unsigned char *pr = m.packs + (size_t)i * PACK_RECORD_SIZE;
      const char *name = manifest_string(&m, get_le32(pr + 16), get_le32(pr + 20));
      if(name && join2(path, sizeof(path), packed_root, name) == 0) unlink(path);
    }
    if(join2(path, sizeof(path), packed_root, AMPR_PACK_INDEX_NAME ".crc") == 0) unlink(path);
    if(join2(path, sizeof(path), packed_root, AMPR_PACK_INDEX_NAME ".runtime") == 0) unlink(path);
    remove_pack_dirs(&m, packed_root);
    if(join2(path, sizeof(path), packed_root, AMPR_PACK_INDEX_NAME) == 0) unlink(path);
  }
  cb_progress(&c, total, total, 1);
  rc = 0;
done:
  manifest_free(&m);
  windows_free(&win);
  free(raw);
  free(buf);
  return rc;
}

/* Packs made before the keep-on-disk rule (or by other tools) can hold files
 * the PS5 needs to find on disk. Writes them next to the packs; the manifest
 * is left alone, so the game still reads its packed copy. */
int
ampr_pack_restore_disk_files(const char *root, int repair, uint32_t *missing,
                             uint32_t *restored, char *err, size_t err_size) {
  ap_manifest_t m;
  ap_windows_t win = { 0 };
  unsigned char *buf = NULL;
  int rc = -1;
  memset(&m, 0, sizeof(m));
  if(missing) *missing = 0;
  if(restored) *restored = 0;
  if(manifest_load(&m, root, 0, err, err_size) != 0) goto done;
  if(windows_init(&win, m.pack_count) != 0) {
    ap_err(err, err_size, "out of memory");
    goto done;
  }
  for(uint64_t f = 0; f < m.file_count; f++) {
    if(file_record_check(&m, f, err, err_size) != 0) goto done;
    const unsigned char *fr = m.files + f * FILE_RECORD_SIZE;
    uint64_t size = get_le64(fr + 8);
    uint32_t flags = get_le32(fr + 40);
    const char *rel = manifest_string(&m, get_le32(fr + 32), get_le32(fr + 36)) + 6;
    char dst[1024], tmp[1100];
    struct stat st;
    if(!(flags & FILE_FLAG_PACKED) || !ampr_pack_keep_on_disk(rel, size)) continue;
    if(join2(dst, sizeof(dst), root, rel) != 0) {
      ap_err(err, err_size, "path too long: %s", rel);
      goto done;
    }
    if(lstat(dst, &st) == 0 && S_ISREG(st.st_mode) && (uint64_t)st.st_size == size) {
      continue;
    }
    if(missing) (*missing)++;
    if(!repair) continue;
    uint32_t first = get_le32(fr + 24);
    uint32_t count = get_le32(fr + 28);
    uint32_t shift = fr[44];
    if(!buf && !(buf = malloc(AP_IO_BUFFER))) {
      ap_err(err, err_size, "out of memory");
      goto done;
    }
    if(mkdirs_parent(dst) != 0) {
      ap_err(err, err_size, "create folder for %s: %s", rel, strerror(errno));
      goto done;
    }
    snprintf(tmp, sizeof(tmp), "%s.lzc-lz4.tmp", dst);
    int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
    if(fd < 0) {
      ap_err(err, err_size, "create %s: %s", rel, strerror(errno));
      goto done;
    }
    (void)fchmod(fd, 0777);
    size_t buffered = 0;
    int bad = 0;
    for(uint32_t k = 0; k < count && !bad; k++) {
      uint32_t rs = chunk_raw_size(size, shift, k);
      if(buffered + rs > AP_IO_BUFFER) {
        bad = write_all(fd, buf, buffered) != 0;
        buffered = 0;
      }
      if(!bad && read_chunk(&m, &win, (uint64_t)first + k, rs, buf + buffered,
                            err, err_size) != 0) {
        close(fd);
        unlink(tmp);
        ap_err(err, err_size, "restore %s", rel);
        goto done;
      }
      buffered += rs;
    }
    if(!bad) bad = (buffered && write_all(fd, buf, buffered) != 0) || fsync(fd) != 0;
    if(close(fd) != 0) bad = 1;
    if(bad || rename(tmp, dst) != 0) {
      ap_err(err, err_size, "restore %s: %s", rel, strerror(errno));
      unlink(tmp);
      goto done;
    }
    (void)chmod(dst, 0777);
    struct timeval tv[2];
    tv[0].tv_sec = tv[1].tv_sec = (time_t)get_le64(fr + 16);
    tv[0].tv_usec = tv[1].tv_usec = 0;
    (void)utimes(dst, tv);
    if(restored) (*restored)++;
  }
  rc = 0;
done:
  manifest_free(&m);
  windows_free(&win);
  free(buf);
  return rc;
}

/* -------------------------------------------------------------- probe */

int
ampr_pack_tree_has_manifest(const char *root) {
  char path[1024];
  struct stat st;
  if(!root || !root[0] || join2(path, sizeof(path), root, AMPR_PACK_INDEX_NAME) != 0) {
    return 0;
  }
  return stat(path, &st) == 0 && S_ISREG(st.st_mode) && st.st_size >= INDEX_HEADER_SIZE;
}

int
ampr_pack_probe(const char *root, ampr_pack_stats_t *st) {
  char path[1024];
  unsigned char h[INDEX_HEADER_SIZE];
  struct stat sst;
  char err[64] = {0};
  if(st) memset(st, 0, sizeof(*st));
  if(!root || join2(path, sizeof(path), root, AMPR_PACK_INDEX_NAME) != 0) return 0;
  int fd = open(path, O_RDONLY);
  if(fd < 0) return 0;
  int ok = fstat(fd, &sst) == 0 &&
           pread_full(fd, h, sizeof(h), 0) == (ssize_t)sizeof(h) &&
           manifest_header_check(h, (size_t)sst.st_size, err, sizeof(err)) == 0;
  close(fd);
  if(!ok) return 0;
  if(st) {
    st->files_total = get_le64(h + 40);
    st->chunks = get_le64(h + 48);
    st->pack_count = get_le32(h + 56);
    st->manifest_bytes = (uint64_t)sst.st_size;
    for(int i = 0; i < 16; i++) snprintf(st->build_id + i * 2, 3, "%02x", h[24 + i]);
  }
  return 1;
}

int
ampr_pack_summary(const char *root, ampr_pack_stats_t *st, char *err,
                  size_t err_size) {
  char path[1024];
  unsigned char *data = NULL;
  size_t size = 0;
  int rc = -1;
  if(st) memset(st, 0, sizeof(*st));
  if(!root || join2(path, sizeof(path), root, AMPR_PACK_INDEX_NAME) != 0 ||
     read_file_alloc(path, &data, &size, (size_t)1 << 31) != 0) {
    ap_err(err, err_size, "read %s: %s", AMPR_PACK_INDEX_NAME, strerror(errno));
    return -1;
  }
  if(size < INDEX_HEADER_SIZE ||
     manifest_header_check(data, size, err, err_size) != 0 ||
     crc32_buf(0, data + INDEX_HEADER_SIZE, size - INDEX_HEADER_SIZE) !=
         get_le32(data + 112)) {
    ap_err(err, err_size, "pack index is damaged");
    goto done;
  }
  uint64_t files = get_le64(data + 40);
  const unsigned char *fr = data + get_le64(data + 72);
  const unsigned char *pr = data + get_le64(data + 88);
  if(st) {
    st->files_total = files;
    st->chunks = get_le64(data + 48);
    st->pack_count = get_le32(data + 56);
    st->manifest_bytes = size;
    for(int i = 0; i < 16; i++) snprintf(st->build_id + i * 2, 3, "%02x", data[24 + i]);
    for(uint64_t i = 0; i < files; i++, fr += FILE_RECORD_SIZE) {
      uint64_t fsize = get_le64(fr + 8);
      if(get_le32(fr + 40) & FILE_FLAG_PACKED) {
        st->files_packed++;
        st->logical_bytes += fsize;
      } else {
        st->files_loose++;
        st->loose_bytes += fsize;
      }
    }
    for(uint32_t i = 0; i < st->pack_count; i++, pr += PACK_RECORD_SIZE) {
      st->pack_bytes += get_le64(pr + 8);
    }
  }
  rc = 0;
done:
  free(data);
  return rc;
}
