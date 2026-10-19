/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline.
 *
 * LZ4 Compression - files a game folder needs before it can boot from
 * ShadowMountPlus. Found on HITMAN 3 and 007 First Light dumps, which both
 * stopped with SIGBUS a few seconds in: the eboot runs its own assert
 * (int 0x42) when packagedefinition.txt can't be opened or scePlayGoOpen
 * fails.
 */

#include "lzc_boot_files.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define PLAYGO_LIB "libScePlayGo.sprx"
#define PLAYGO_EMU_MARKER "PlayGo PRX stub"
#define PLAYGO_EMU_MAX (4u << 20)

const char *const lzc_boot_playgo_sources[] = {
  "/data/LZ4Compression/import/libs",
  "/data/shadowmount/emus",
  "/data/shadowmount/fakelib",
  "games:/data/homebrew",
  "games:/data/etaHEN/games",
  "games:/mnt/ext0/homebrew",
  "games:/mnt/ext1/homebrew",
  "games:/mnt/ext0/etaHEN/games",
  "games:/mnt/ext1/etaHEN/games",
  "games:/mnt/usb0/homebrew",
  "games:/mnt/usb1/homebrew",
  "games:/mnt/shadowmnt",
  NULL,
};

static void
set_err(char *err, size_t err_size, const char *fmt, const char *a,
        const char *b) {
  if(err && err_size) snprintf(err, err_size, fmt, a, b);
}

static int
join(char *out, size_t size, const char *a, const char *b) {
  return snprintf(out, size, "%s/%s", a, b) < (int)size ? 0 : -1;
}

static int
is_dir(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

static int
is_file(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

/* Scans a file for needle; out (when set) gets the bytes that follow it, up
 * to out_size - 1 of them. 1 found, 0 not, -1 unreadable. The strings the
 * check needs are readable in the fake-signed SELFs games run from. */
static int
scan_file(const char *path, const char *needle, size_t limit, char *out,
          size_t out_size) {
  const size_t n = strlen(needle);
  const size_t chunk = 4u << 20;
  const size_t tail = n + (out ? out_size : 0);
  unsigned char *buf;
  size_t carry = 0, total = 0;
  int found = 0;
  int fd = open(path, O_RDONLY);
  if(fd < 0) return -1;
  buf = malloc(chunk + tail);
  if(!buf) {
    close(fd);
    return -1;
  }
  for(;;) {
    ssize_t got = read(fd, buf + carry, chunk);
    int eof = got <= 0;
    size_t len = carry + (got > 0 ? (size_t)got : 0);
    size_t keep_from = len;
    if(got > 0) total += (size_t)got;
    for(size_t i = 0; i + n <= len; i++) {
      if(buf[i] != (unsigned char)needle[0] || memcmp(buf + i, needle, n)) continue;
      if(out && !eof && len - i - n < out_size - 1) {
        /* The value may run on into the next read: keep it for then. */
        keep_from = i;
        break;
      }
      if(out) {
        size_t k = 0;
        while(k < out_size - 1 && i + n + k < len) {
          unsigned char c = buf[i + n + k];
          if(c < 0x21 || c > 0x7e) break;
          out[k++] = (char)c;
        }
        out[k] = 0;
      }
      found = 1;
      break;
    }
    if(found || eof || (limit && total >= limit)) break;
    if(keep_from == len) keep_from = len < n ? 0 : len - (n - 1);
    carry = len - keep_from;
    memmove(buf, buf + keep_from, carry);
  }
  free(buf);
  close(fd);
  return found;
}

int
lzc_boot_is_playgo_emu(const char *path) {
  struct stat st;
  if(stat(path, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0 ||
     (size_t)st.st_size > PLAYGO_EMU_MAX) {
    return 0;
  }
  return scan_file(path, PLAYGO_EMU_MARKER, 0, NULL, 0) == 1;
}

/* An entry of dir named name in any case. 1 found (its name in out), 0 not. */
static int
find_entry_nocase(const char *dir, const char *name, char *out, size_t size) {
  DIR *d = opendir(dir);
  struct dirent *ent;
  int found = 0;
  if(!d) return 0;
  while(!found && (ent = readdir(d)) != NULL) {
    if(!strcasecmp(ent->d_name, name)) {
      snprintf(out, size, "%s", ent->d_name);
      found = 1;
    }
  }
  closedir(d);
  return found;
}

/* 1 when dir lists an entry spelled exactly name. */
static int
entry_exact(const char *dir, const char *name) {
  DIR *d = opendir(dir);
  struct dirent *ent;
  int found = 0;
  if(!d) return 0;
  while(!found && (ent = readdir(d)) != NULL) found = !strcmp(ent->d_name, name);
  closedir(d);
  return found;
}

/* 1 when eboot.bin or a module in sce_module/ names the library. */
static int
title_imports(const char *root, const char *lib) {
  char path[1024];
  if(join(path, sizeof(path), root, "eboot.bin") == 0 &&
     scan_file(path, lib, 0, NULL, 0) == 1) {
    return 1;
  }
  if(join(path, sizeof(path), root, "sce_module") != 0) return 0;
  DIR *d = opendir(path);
  struct dirent *ent;
  int found = 0;
  while(d && !found && (ent = readdir(d)) != NULL) {
    char prx[1024];
    size_t len = strlen(ent->d_name);
    if(len < 5 || strcasecmp(ent->d_name + len - 4, ".prx")) continue;
    if(join(prx, sizeof(prx), path, ent->d_name) == 0) {
      found = scan_file(prx, lib, 0, NULL, 0) == 1;
    }
  }
  if(d) closedir(d);
  return found;
}

static int
check_runtime_case(const char *root, int repair, lzc_boot_report_t *r,
                   char *err, size_t err_size) {
  char eboot[1024], want[64] = {0}, have[256], from[1024], to[1024];
  if(join(eboot, sizeof(eboot), root, "eboot.bin") != 0 ||
     scan_file(eboot, "RUNTIME_PATH=", 0, want, sizeof(want)) != 1) {
    return 0;
  }
  char *name = want;
  while(!strncmp(name, "./", 2)) name += 2;
  size_t len = strlen(name);
  while(len && name[len - 1] == '/') name[--len] = 0;
  /* Only a single folder name; anything else is left to the game. */
  if(!len || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return 0;
  /* Compare names as listed, so a case-insensitive volume (exFAT, the
   * Mac running the tests) doesn't hide the mismatch. */
  if(join(to, sizeof(to), root, name) != 0 || entry_exact(root, name) ||
     !find_entry_nocase(root, name, have, sizeof(have)) ||
     join(from, sizeof(from), root, have) != 0 || !is_dir(from)) {
    return 0;
  }
  r->runtime_case_wrong = 1;
  snprintf(r->runtime_found, sizeof(r->runtime_found), "%s", have);
  snprintf(r->runtime_expected, sizeof(r->runtime_expected), "%s", name);
  if(!repair) return 0;
  /* Through a temporary name: a case-only rename is a no-op or an error
   * on some case-insensitive filesystems. */
  char tmp[1100];
  snprintf(tmp, sizeof(tmp), "%s.lzc-rename", to);
  if(rename(from, tmp) != 0) {
    set_err(err, err_size, "rename %s: %s", have, strerror(errno));
    return -1;
  }
  if(rename(tmp, to) != 0) {
    int e = errno;
    rename(tmp, from);
    set_err(err, err_size, "rename %s: %s", have, strerror(e));
    return -1;
  }
  r->runtime_renamed = 1;
  return 0;
}

static int
find_playgo_in_fakelib(const char *game, char *out, size_t size) {
  char fl[256], dir[1024], name[256], path[1024];
  if(!find_entry_nocase(game, "fakelib", fl, sizeof(fl)) ||
     join(dir, sizeof(dir), game, fl) != 0 ||
     !find_entry_nocase(dir, PLAYGO_LIB, name, sizeof(name)) ||
     join(path, sizeof(path), dir, name) != 0 || !lzc_boot_is_playgo_emu(path)) {
    return 0;
  }
  snprintf(out, size, "%s", path);
  return 1;
}

static int
name_cmp(const void *a, const void *b) {
  return strcmp(*(char *const *)a, *(char *const *)b);
}

/* First PlayGo emulator found in the sources, skipping root itself. */
static int
find_playgo_emu(const char *root, const char *const *sources, char *out,
                size_t size) {
  for(size_t i = 0; sources[i]; i++) {
    const char *src = sources[i];
    if(strncmp(src, "games:", 6)) {
      char path[1024];
      if(join(path, sizeof(path), src, PLAYGO_LIB) == 0 &&
         lzc_boot_is_playgo_emu(path)) {
        snprintf(out, size, "%s", path);
        return 1;
      }
      continue;
    }
    src += 6;
    DIR *d = opendir(src);
    struct dirent *ent;
    char **names = NULL;
    size_t count = 0, cap = 0;
    int found = 0;
    if(!d) continue;
    while((ent = readdir(d)) != NULL) {
      if(ent->d_name[0] == '.') continue;
      if(count == cap) {
        size_t ncap = cap ? cap * 2 : 32;
        char **grown = realloc(names, ncap * sizeof(*names));
        if(!grown) break;
        names = grown;
        cap = ncap;
      }
      if((names[count] = strdup(ent->d_name)) != NULL) count++;
    }
    closedir(d);
    if(count) qsort(names, count, sizeof(*names), name_cmp);
    for(size_t k = 0; k < count; k++) {
      char game[1024];
      if(!found && join(game, sizeof(game), src, names[k]) == 0 &&
         strcmp(game, root) && is_dir(game)) {
        found = find_playgo_in_fakelib(game, out, size);
      }
      free(names[k]);
    }
    free(names);
    if(found) return 1;
  }
  return 0;
}

static int
copy_file_atomic(const char *src, const char *dst, char *err, size_t err_size) {
  char tmp[1100];
  char buf[65536];
  int in, outfd, rc = -1;
  snprintf(tmp, sizeof(tmp), "%s.lzc-tmp", dst);
  in = open(src, O_RDONLY);
  if(in < 0) {
    set_err(err, err_size, "open %s: %s", src, strerror(errno));
    return -1;
  }
  outfd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0777);
  if(outfd < 0) {
    set_err(err, err_size, "create %s: %s", tmp, strerror(errno));
    close(in);
    return -1;
  }
  for(;;) {
    ssize_t got = read(in, buf, sizeof(buf));
    if(got == 0) {
      rc = 0;
      break;
    }
    if(got < 0 || write(outfd, buf, (size_t)got) != got) {
      set_err(err, err_size, "copy %s: %s", src, strerror(errno ? errno : EIO));
      break;
    }
  }
  close(in);
  if(close(outfd) != 0 && rc == 0) {
    set_err(err, err_size, "write %s: %s", tmp, strerror(errno));
    rc = -1;
  }
  if(rc == 0 && (chmod(tmp, 0777) != 0 || rename(tmp, dst) != 0)) {
    set_err(err, err_size, "publish %s: %s", dst, strerror(errno));
    rc = -1;
  }
  if(rc != 0) unlink(tmp);
  return rc;
}

static int
check_playgo(const char *root, int repair, const char *const *sources,
             lzc_boot_report_t *r, char *err, size_t err_size) {
  char fl[256], dir[1024], name[256], dst[1024];
  int have_fakelib = find_entry_nocase(root, "fakelib", fl, sizeof(fl));
  /* Any libScePlayGo in fakelib counts: a backport or an emulator someone
   * chose is left alone. */
  if(have_fakelib && join(dir, sizeof(dir), root, fl) == 0 &&
     find_entry_nocase(dir, PLAYGO_LIB, name, sizeof(name))) {
    return 0;
  }
  if(!title_imports(root, "libScePlayGo")) return 0;
  r->playgo_missing = 1;
  if(!find_playgo_emu(root, sources, r->playgo_source, sizeof(r->playgo_source))) {
    r->playgo_source[0] = 0;
    return 0;
  }
  if(!repair) return 0;
  if(!have_fakelib) snprintf(fl, sizeof(fl), "%s", "fakelib");
  if(join(dir, sizeof(dir), root, fl) != 0) return -1;
  if(!have_fakelib && mkdir(dir, 0777) != 0 && errno != EEXIST) {
    set_err(err, err_size, "create %s: %s", dir, strerror(errno));
    return -1;
  }
  chmod(dir, 0777);
  if(join(dst, sizeof(dst), dir, PLAYGO_LIB) != 0 ||
     copy_file_atomic(r->playgo_source, dst, err, err_size) != 0) {
    return -1;
  }
  r->playgo_added = 1;
  return 0;
}

static void
check_eboot_format(const char *root, lzc_boot_report_t *r) {
  char path[1024];
  unsigned char magic[4] = {0};
  if(join(path, sizeof(path), root, "eboot.bin") != 0) return;
  int fd = open(path, O_RDONLY);
  if(fd < 0) return;
  if(read(fd, magic, 4) == 4 && !memcmp(magic, "\177ELF", 4)) {
    r->eboot_plain_elf = 1;
  }
  close(fd);
}

/* AMPRIDX3, as APR-EMU writes it: a 48-byte header, entry_count 24-byte
 * records (path offset, path length, size, mtime), then the NUL-terminated
 * /app0/... paths. */
#define AMPR_INDEX_NAME "ampr_emu.index"
#define AMPR_INDEX_MAX (256u << 20)

static uint32_t
rd32(const unsigned char *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 |
         (uint32_t)p[3] << 24;
}

static uint64_t
rd64(const unsigned char *p) {
  return (uint64_t)rd32(p) | (uint64_t)rd32(p + 4) << 32;
}

static int
check_ampr_index(const char *root, int repair, lzc_boot_report_t *r,
                 char *err, size_t err_size) {
  char path[1024], file[1024];
  struct stat st;
  unsigned char *buf = NULL;
  int fd, stale = 0;
  if(join(path, sizeof(path), root, AMPR_INDEX_NAME) != 0 ||
     stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
    return 0;
  }
  /* Anything this check can't read is left for APR-EMU to judge. */
  if(st.st_size < 48 || (uint64_t)st.st_size > AMPR_INDEX_MAX) return 0;
  const uint64_t size = (uint64_t)st.st_size;
  if((fd = open(path, O_RDONLY)) < 0) return 0;
  buf = malloc(size);
  if(buf && read(fd, buf, size) == (ssize_t)size &&
     !memcmp(buf, "AMPRIDX3", 8) && rd32(buf + 8) == 3 && rd32(buf + 12) == 24) {
    uint64_t count = rd64(buf + 16), path_bytes = rd64(buf + 24);
    uint64_t blob = 48 + count * 24;
    if(count <= (size - 48) / 24 && path_bytes <= size - blob) {
      for(uint64_t i = 0; i < count && !stale; i++) {
        const unsigned char *rec = buf + 48 + i * 24;
        uint32_t off = rd32(rec), len = rd32(rec + 4);
        const char *p = (const char *)buf + blob + off;
        if((uint64_t)off + len >= path_bytes || p[len] != 0 ||
           strncmp(p, "/app0/", 6) || len - 6 >= sizeof(file) - strlen(root) - 1) {
          continue;
        }
        snprintf(file, sizeof(file), "%s/%s", root, p + 6);
        if(lstat(file, &st) != 0 || !S_ISREG(st.st_mode) ||
           (uint64_t)st.st_size != rd64(rec + 8)) {
          snprintf(r->ampr_index_missing, sizeof(r->ampr_index_missing), "%s",
                   p + 6);
          stale = 1;
        }
      }
    }
  }
  free(buf);
  close(fd);
  if(!stale) return 0;
  r->ampr_index_stale = 1;
  if(!repair) return 0;
  if(join(file, sizeof(file), root, AMPR_INDEX_NAME ".stale") != 0 ||
     rename(path, file) != 0) {
    set_err(err, err_size, "move %s aside: %s", AMPR_INDEX_NAME,
            strerror(errno));
    return -1;
  }
  r->ampr_index_removed = 1;
  return 0;
}

int
lzc_boot_reads_packages_from_disk(const char *root) {
  char name[256], dir[1024];
  DIR *d;
  struct dirent *ent;
  int found = 0;
  if(!find_entry_nocase(root, "runtime", name, sizeof(name)) ||
     join(dir, sizeof(dir), root, name) != 0 || !is_dir(dir)) {
    return 0;
  }
  if(find_entry_nocase(dir, "packagedefinition.txt", name, sizeof(name))) return 1;
  if(!(d = opendir(dir))) return 0;
  while(!found && (ent = readdir(d)) != NULL) {
    size_t len = strlen(ent->d_name);
    found = len > 5 && !strcasecmp(ent->d_name + len - 5, ".rpkg");
  }
  closedir(d);
  return found;
}

int
lzc_boot_files_check(const char *root, int repair, int packed,
                     const char *const *sources, lzc_boot_report_t *r,
                     char *err, size_t err_size) {
  char eboot[1024];
  memset(r, 0, sizeof(*r));
  if(err && err_size) err[0] = 0;
  if(!sources) sources = lzc_boot_playgo_sources;
  if(join(eboot, sizeof(eboot), root, "eboot.bin") != 0 || !is_file(eboot)) {
    return 0;
  }
  check_eboot_format(root, r);
  if(check_runtime_case(root, repair, r, err, err_size) != 0) return -1;
  if(check_playgo(root, repair, sources, r, err, err_size) != 0) return -1;
  /* After the runtime rename, which is what usually leaves it stale. */
  if(!packed && check_ampr_index(root, repair, r, err, err_size) != 0) return -1;
  return 0;
}
