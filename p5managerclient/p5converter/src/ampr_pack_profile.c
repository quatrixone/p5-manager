/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - AMPR LZ4 pack profiles.
 *
 * Builds the packing configuration either from a TOML profile (the format
 * ampr_pack.py reads) or from the automatic scan-based profile, including
 * the safety exclusions and learned loose patterns.
 */

#include "ampr_pack_internal.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <float.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>

#define KIB 1024ULL
#define MIB (1024ULL * 1024ULL)
#define GIB (1024ULL * 1024ULL * 1024ULL)

/* isfinite() from the PS5 SDK headers trips -Wunreachable-code-generic-assoc. */
static int
ap_finite(double v) {
  return v == v && v <= DBL_MAX && v >= -DBL_MAX;
}

static void
cfg_err(char *err, size_t err_size, const char *fmt, ...) {
  if(!err || !err_size || err[0]) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(err, err_size, fmt, ap);
  va_end(ap);
}

/* ----------------------------------------------------------- strlist */

int
ap_strlist_add(ap_strlist_t *l, const char *s) {
  if(l->count == l->cap) {
    size_t next = l->cap ? l->cap * 2 : 16;
    char **items = realloc(l->items, next * sizeof(*items));
    if(!items) return -1;
    l->items = items;
    l->cap = next;
  }
  char *copy = strdup(s ? s : "");
  if(!copy) return -1;
  l->items[l->count++] = copy;
  return 0;
}

int
ap_strlist_contains(const ap_strlist_t *l, const char *s) {
  for(size_t i = 0; l && i < l->count; i++) {
    if(!strcmp(l->items[i], s)) return 1;
  }
  return 0;
}

void
ap_strlist_free(ap_strlist_t *l) {
  if(!l) return;
  for(size_t i = 0; i < l->count; i++) free(l->items[i]);
  free(l->items);
  memset(l, 0, sizeof(*l));
}

static int
strlist_copy(ap_strlist_t *dst, const ap_strlist_t *src) {
  for(size_t i = 0; i < src->count; i++) {
    if(ap_strlist_add(dst, src->items[i]) != 0) return -1;
  }
  return 0;
}

/* -------------------------------------------------------------- glob */

/* Finds the closing ']' the way fnmatch.translate() does; -1 if literal. */
static long
class_end(const char *p) {
  long j = 0;
  if(p[j] == '!') j++;
  if(p[j] == ']') j++;
  while(p[j] && p[j] != ']') j++;
  return p[j] == ']' ? j : -1;
}

static int
class_match(const char *p, long end, unsigned char ch) {
  long k = 0;
  int neg = 0;
  int matched = 0;
  if(p[k] == '!') {
    neg = 1;
    k++;
  }
  if(k >= end) return neg; /* "[!]" matches any character, "[]" none */
  while(k < end) {
    unsigned char lo = (unsigned char)p[k];
    if(k + 2 < end && p[k + 1] == '-') {
      unsigned char hi = (unsigned char)p[k + 2];
      if(ch >= lo && ch <= hi) matched = 1;
      k += 3;
    } else {
      if(ch == lo) matched = 1;
      k++;
    }
  }
  return neg ? !matched : matched;
}

/* Tries to consume one pattern element against ch; advances *pp on match. */
static int
match_one(const char **pp, unsigned char ch) {
  const char *p = *pp;
  if(!*p) return 0;
  if(*p == '?') {
    *pp = p + 1;
    return 1;
  }
  if(*p == '[') {
    long end = class_end(p + 1);
    if(end >= 0) {
      if(!class_match(p + 1, end, ch)) return 0;
      *pp = p + 1 + end + 1;
      return 1;
    }
    if(ch != '[') return 0;
    *pp = p + 1;
    return 1;
  }
  if((unsigned char)*p != ch) return 0;
  *pp = p + 1;
  return 1;
}

int
ap_fnmatch(const char *pattern, const char *name) {
  const char *p = pattern ? pattern : "";
  const char *s = name ? name : "";
  const char *star_p = NULL;
  const char *star_s = NULL;
  while(*s) {
    if(*p == '*') {
      while(*p == '*') p++;
      star_p = p;
      star_s = s;
      continue;
    }
    if(match_one(&p, (unsigned char)*s)) {
      s++;
      continue;
    }
    if(star_p) {
      p = star_p;
      s = ++star_s;
      continue;
    }
    return 0;
  }
  while(*p == '*') p++;
  return *p == 0;
}

static const char *
strip_leading_slashes(const char *s, char *buf, size_t buf_size) {
  size_t n = 0;
  for(const char *p = s; *p && n + 1 < buf_size; p++) {
    buf[n++] = *p == '\\' ? '/' : *p;
  }
  buf[n] = 0;
  const char *out = buf;
  while(*out == '/') out++;
  return out;
}

int
ap_glob_matches(const char *rel, const ap_strlist_t *patterns) {
  char name_buf[1024];
  char pat_buf[1024];
  if(!patterns || patterns->count == 0) return 0;
  const char *name = strip_leading_slashes(rel ? rel : "", name_buf,
                                           sizeof(name_buf));
  for(size_t i = 0; i < patterns->count; i++) {
    const char *pat = strip_leading_slashes(patterns->items[i], pat_buf,
                                            sizeof(pat_buf));
    if(ap_fnmatch(pat, name)) return 1;
  }
  return 0;
}

int
ap_segment_glob_match(const char *p, const char *s) {
  if(!*p) return !*s;
  if(p[0] == '*' && p[1] == '*') {
    for(size_t k = 0;; k++) {
      if(ap_segment_glob_match(p + 2, s + k)) return 1;
      if(!s[k]) return 0;
    }
  }
  if(p[0] == '*') {
    for(size_t k = 0;; k++) {
      if(ap_segment_glob_match(p + 1, s + k)) return 1;
      if(!s[k] || s[k] == '/') return 0;
    }
  }
  if(!*s) return 0;
  if(p[0] == '?') return ap_segment_glob_match(p + 1, s + 1);
  return *p == *s && ap_segment_glob_match(p + 1, s + 1);
}

/* ------------------------------------------------------------- sizes */

int
ap_parse_size_text(const char *text, uint64_t *out) {
  char buf[64];
  size_t n = 0;
  for(const char *p = text ? text : ""; *p && n + 1 < sizeof(buf); p++) {
    if(*p == '_') continue;
    buf[n++] = *p;
  }
  buf[n] = 0;
  char *start = buf;
  while(*start && isspace((unsigned char)*start)) start++;
  size_t len = strlen(start);
  while(len && isspace((unsigned char)start[len - 1])) start[--len] = 0;
  if(!len) return -1;
  size_t split = len;
  while(split && isalpha((unsigned char)start[split - 1])) split--;
  char suffix[8] = "b";
  if(split < len) {
    if(len - split >= sizeof(suffix)) return -1;
    for(size_t i = split; i < len; i++) {
      suffix[i - split] = (char)tolower((unsigned char)start[i]);
    }
    suffix[len - split] = 0;
  }
  start[split] = 0;
  static const struct { const char *name; double mul; } units[] = {
    { "b", 1.0 }, { "k", 1e3 }, { "kb", 1e3 }, { "kib", 1024.0 },
    { "m", 1e6 }, { "mb", 1e6 }, { "mib", 1048576.0 },
    { "g", 1e9 }, { "gb", 1e9 }, { "gib", 1073741824.0 },
    { "t", 1e12 }, { "tb", 1e12 }, { "tib", 1099511627776.0 },
  };
  double mul = 0;
  for(size_t i = 0; i < sizeof(units) / sizeof(units[0]); i++) {
    if(!strcmp(units[i].name, suffix)) {
      mul = units[i].mul;
      break;
    }
  }
  if(mul == 0) return -1;
  char *endp = NULL;
  errno = 0;
  double v = strtod(start, &endp);
  if(!endp || endp == start || errno || !ap_finite(v)) return -1;
  while(*endp && isspace((unsigned char)*endp)) endp++;
  if(*endp) return -1;
  double r = v * mul;
  if(r < 0 || r >= 18446744073709551615.0) return -1;
  *out = (uint64_t)r;
  return 0;
}

int
ap_block_shift_from_size(uint64_t size, int *shift_out) {
  if(size == 0 || (size & (size - 1))) return -1;
  int shift = 0;
  while((1ULL << shift) < size) shift++;
  if(shift < AP_MIN_BLOCK_SHIFT || shift > AP_MAX_BLOCK_SHIFT) return -1;
  *shift_out = shift;
  return 0;
}

/* --------------------------------------------------------- toml read */

static int
tv_size(const ap_tval_t *v, uint64_t *out) {
  if(!v) return 1;
  if(v->type == AP_TV_INT) {
    if(v->i < 0) return -1;
    *out = (uint64_t)v->i;
    return 0;
  }
  if(v->type == AP_TV_STRING) return ap_parse_size_text(v->s, out);
  return -1;
}

static int
tv_int(const ap_tval_t *v, int64_t *out) {
  if(!v) return 1;
  if(v->type == AP_TV_INT) {
    *out = v->i;
    return 0;
  }
  if(v->type == AP_TV_FLOAT && ap_finite(v->f)) {
    *out = (int64_t)v->f;
    return 0;
  }
  if(v->type == AP_TV_BOOL) {
    *out = v->b;
    return 0;
  }
  if(v->type == AP_TV_STRING) {
    char *endp = NULL;
    errno = 0;
    long long i = strtoll(v->s, &endp, 10);
    if(!endp || endp == v->s || *endp || errno) return -1;
    *out = i;
    return 0;
  }
  return -1;
}

static int
tv_float(const ap_tval_t *v, double *out) {
  if(!v) return 1;
  if(v->type == AP_TV_FLOAT) {
    *out = v->f;
    return 0;
  }
  if(v->type == AP_TV_INT) {
    *out = (double)v->i;
    return 0;
  }
  if(v->type == AP_TV_STRING) {
    char *endp = NULL;
    double f = strtod(v->s, &endp);
    if(!endp || endp == v->s || *endp) return -1;
    *out = f;
    return 0;
  }
  return -1;
}

/* Python bool(): non-empty strings and non-zero numbers are true. */
static int
tv_bool(const ap_tval_t *v, int *out) {
  if(!v) return 1;
  if(v->type == AP_TV_BOOL) *out = v->b;
  else if(v->type == AP_TV_INT) *out = v->i != 0;
  else if(v->type == AP_TV_FLOAT) *out = v->f != 0.0;
  else if(v->type == AP_TV_STRING) *out = v->s[0] != 0;
  else if(v->type == AP_TV_ARRAY) *out = v->count != 0;
  else *out = 1;
  return 0;
}

static int
tv_string(const ap_tval_t *v, char *out, size_t out_size) {
  if(!v) return 1;
  if(v->type != AP_TV_STRING) return -1;
  size_t n = strlen(v->s);
  if(n >= out_size) return -1;
  memcpy(out, v->s, n + 1);
  return 0;
}

static int
tv_strlist(const ap_tval_t *v, ap_strlist_t *out) {
  if(!v) return 1;
  if(v->type == AP_TV_STRING) return ap_strlist_add(out, v->s);
  if(v->type != AP_TV_ARRAY || v->table_array) return -1;
  for(size_t i = 0; i < v->count; i++) {
    if(v->items[i]->type != AP_TV_STRING) return -1;
    if(ap_strlist_add(out, v->items[i]->s) != 0) return -1;
  }
  return 0;
}

static void
lower_inplace(char *s) {
  for(; *s; s++) *s = (char)tolower((unsigned char)*s);
}

/* ------------------------------------------------------------ config */

void
ap_config_init_defaults(ap_config_t *cfg) {
  memset(cfg, 0, sizeof(*cfg));
  snprintf(cfg->index_name, sizeof(cfg->index_name), "%s", "ampr_assets.index");
  snprintf(cfg->pack_pattern, sizeof(cfg->pack_pattern), "%s",
           "ampr_assets-{id:03d}.pak");
  cfg->default_action = AP_ACTION_LOOSE;
  cfg->default_block_shift = 16;
  cfg->io_page_size = 64 * 1024;
  cfg->payload_alignment = 64 * 1024;
  cfg->chunk_alignment = 64;
  cfg->workers = 8;
  cfg->mode_hc = 1;
  cfg->level = 12;
  cfg->acceleration = 1;
  cfg->min_savings_bytes = 64;
  cfg->min_savings_ratio = 0.01;
  cfg->io_neutral_min_savings_bytes = 8 * 1024;
  cfg->io_neutral_min_savings_ratio = 0.125;
  cfg->deduplicate = 1;
  cfg->dedupe_scope_group = 0;
  cfg->deduplicate_streaming = 0;
  cfg->preserve_mtime = 1;
  cfg->validate_index_metadata = 1;
  cfg->self_contained = 0;
  cfg->auto_loose_large_files = 1;
  cfg->auto_loose_hot_files = 0;
  cfg->auto_loose_min_file_size = 64 * MIB;
  cfg->auto_loose_sample_blocks = 32;
  cfg->auto_loose_sample_bytes = 16 * MIB;
  cfg->auto_loose_min_savings_ratio = 0.05;
  cfg->auto_loose_max_raw_ratio = 0.90;
  snprintf(cfg->source, sizeof(cfg->source), "%s", "default");
}

static void
rule_free(ap_rule_t *r) {
  ap_strlist_free(&r->include);
  ap_strlist_free(&r->exclude);
}

void
ap_config_free(ap_config_t *cfg) {
  if(!cfg) return;
  for(size_t i = 0; i < cfg->rule_count; i++) rule_free(&cfg->rules[i]);
  free(cfg->rules);
  free(cfg->groups);
  ap_strlist_free(&cfg->required_packed);
  ap_strlist_free(&cfg->force_loose);
  memset(cfg, 0, sizeof(*cfg));
}

int
ap_config_find_group(const ap_config_t *cfg, const char *name) {
  for(size_t i = 0; i < cfg->group_count; i++) {
    if(!strcmp(cfg->groups[i].name, name)) return (int)i;
  }
  return -1;
}

static int
config_add_group(ap_config_t *cfg, const char *name, ap_group_t **out) {
  if(strlen(name) >= sizeof(cfg->groups[0].name)) return -1;
  ap_group_t *g = realloc(cfg->groups, (cfg->group_count + 1) * sizeof(*g));
  if(!g) return -1;
  cfg->groups = g;
  ap_group_t *grp = &cfg->groups[cfg->group_count++];
  memset(grp, 0, sizeof(*grp));
  snprintf(grp->name, sizeof(grp->name), "%s", name);
  grp->pack_count = 1;
  grp->assignment = AP_ASSIGN_BALANCED;
  grp->stripe_threshold = 256 * MIB;
  grp->stripe_group_blocks = 8;
  if(out) *out = grp;
  return 0;
}

static ap_rule_t *
config_add_rule(ap_config_t *cfg) {
  ap_rule_t *r = realloc(cfg->rules, (cfg->rule_count + 1) * sizeof(*r));
  if(!r) return NULL;
  cfg->rules = r;
  ap_rule_t *rule = &cfg->rules[cfg->rule_count++];
  memset(rule, 0, sizeof(*rule));
  rule->action = AP_ACTION_COMPRESS;
  rule->block_shift = cfg->default_block_shift;
  rule->group = -1;
  rule->mode_hc = cfg->mode_hc;
  rule->level = cfg->level;
  rule->acceleration = cfg->acceleration;
  rule->min_savings_bytes = cfg->min_savings_bytes;
  rule->min_savings_ratio = cfg->min_savings_ratio;
  rule->io_neutral_min_savings_bytes = cfg->io_neutral_min_savings_bytes;
  rule->io_neutral_min_savings_ratio = cfg->io_neutral_min_savings_ratio;
  rule->layout = AP_LAYOUT_AUTO;
  return rule;
}

static int
safe_relative_name(const char *name) {
  if(!name || !name[0] || name[0] == '/' || strchr(name, '\\')) return 0;
  size_t len = strlen(name);
  if(name[len - 1] == '/') return 0;
  const char *p = name;
  while(*p) {
    const char *slash = strchr(p, '/');
    size_t n = slash ? (size_t)(slash - p) : strlen(p);
    if(n == 0 || (n == 1 && p[0] == '.') ||
       (n == 2 && p[0] == '.' && p[1] == '.')) {
      return 0;
    }
    p += n;
    if(*p == '/') p++;
  }
  return 1;
}

/* Renders str.format() fields {group}, {lane}, {volume}, {id} with an
 * optional ":[0][width]d" spec. glob_out (optional) receives the glob used
 * to keep earlier outputs loose. */
static int
render_pack_pattern(const char *pattern, const char *group, uint32_t lane,
                    uint32_t volume, uint32_t id, char *out, size_t out_size,
                    char *glob_out, size_t glob_size) {
  size_t n = 0;
  size_t g = 0;
#define PUT(c) do { if(n + 1 >= out_size) return -1; out[n++] = (c); } while(0)
#define GPUT(c) do { if(glob_out) { if(g + 1 >= glob_size) return -1; glob_out[g++] = (c); } } while(0)
  for(const char *p = pattern; *p;) {
    if(p[0] == '{' && p[1] == '{') {
      PUT('{');
      GPUT('{');
      p += 2;
      continue;
    }
    if(p[0] == '}' && p[1] == '}') {
      PUT('}');
      GPUT('}');
      p += 2;
      continue;
    }
    if(*p == '}') return -1;
    if(*p != '{') {
      char c = *p == '\\' ? '/' : *p;
      PUT(c);
      GPUT(c);
      p++;
      continue;
    }
    const char *close = strchr(p, '}');
    if(!close) return -1;
    char field[32];
    char spec[16] = "";
    size_t flen = (size_t)(close - p - 1);
    if(flen == 0 || flen >= sizeof(field)) return -1;
    memcpy(field, p + 1, flen);
    field[flen] = 0;
    char *colon = strchr(field, ':');
    if(colon) {
      *colon = 0;
      if(strlen(colon + 1) >= sizeof(spec)) return -1;
      snprintf(spec, sizeof(spec), "%s", colon + 1);
    }
    char rendered[96];
    if(!strcmp(field, "group")) {
      if(spec[0] && strcmp(spec, "s")) return -1;
      snprintf(rendered, sizeof(rendered), "%s", group);
    } else if(!strcmp(field, "lane") || !strcmp(field, "volume") ||
              !strcmp(field, "id")) {
      uint32_t value = !strcmp(field, "lane") ? lane :
                       !strcmp(field, "volume") ? volume : id;
      int zero = 0;
      int width = 0;
      const char *s = spec;
      if(*s == '0') {
        zero = 1;
        s++;
      }
      while(*s >= '0' && *s <= '9') width = width * 10 + (*s++ - '0');
      if(*s == 'd') s++;
      if(*s || width > 20) return -1;
      if(zero) snprintf(rendered, sizeof(rendered), "%0*u", width, value);
      else snprintf(rendered, sizeof(rendered), "%*u", width, value);
    } else {
      return -1;
    }
    for(const char *r = rendered; *r; r++) PUT(*r == '\\' ? '/' : *r);
    GPUT('*');
    p = close + 1;
  }
  out[n] = 0;
  if(glob_out) glob_out[g] = 0;
#undef PUT
#undef GPUT
  return 0;
}

int
ap_render_pack_name(const ap_config_t *cfg, const char *group, uint32_t lane,
                    uint32_t volume, uint32_t id, char *out, size_t out_size) {
  if(render_pack_pattern(cfg->pack_pattern, group, lane, volume, id, out,
                         out_size, NULL, 0) != 0) {
    return -1;
  }
  return safe_relative_name(out) ? 0 : -1;
}

static int
cmp_group_names(const void *a, const void *b) {
  const ap_group_t *const *ga = a;
  const ap_group_t *const *gb = b;
  return strcmp((*ga)->name, (*gb)->name);
}

int
ap_config_finalize(ap_config_t *cfg, char *err, size_t err_size) {
  char rendered[512];
  char glob[256];
  if(cfg->workers < 1 || cfg->workers > 256) {
    cfg_err(err, err_size, "workers must be between 1 and 256");
    return -1;
  }
  uint32_t io = cfg->io_page_size;
  if(io < (1u << AP_MIN_IO_PAGE_SHIFT) || (io & (io - 1)) ||
     io > (1u << AP_MAX_IO_PAGE_SHIFT)) {
    cfg_err(err, err_size, "io_page_size must be a power of two between 4 KiB and 1 MiB");
    return -1;
  }
  uint32_t pa = cfg->payload_alignment;
  if(pa < 64 || (pa & (pa - 1)) || pa > (1u << AP_MAX_BLOCK_SHIFT)) {
    cfg_err(err, err_size, "payload_alignment must be a power of two between 64 B and 1 MiB");
    return -1;
  }
  uint32_t ca = cfg->chunk_alignment;
  if(ca < 64 || (ca & (ca - 1)) || ca > io || io % ca) {
    cfg_err(err, err_size, "chunk_alignment must be a power of two between 64 B and io_page_size");
    return -1;
  }
  if(cfg->level < 1 || cfg->level > 12) {
    cfg_err(err, err_size, "compression_level must be between 1 and 12");
    return -1;
  }
  if(cfg->acceleration < 1) {
    cfg_err(err, err_size, "acceleration must be at least 1");
    return -1;
  }
  if(!(cfg->min_savings_ratio >= 0.0 && cfg->min_savings_ratio < 1.0) ||
     !(cfg->io_neutral_min_savings_ratio >= 0.0 &&
       cfg->io_neutral_min_savings_ratio < 1.0) ||
     !(cfg->auto_loose_min_savings_ratio >= 0.0 &&
       cfg->auto_loose_min_savings_ratio < 1.0) ||
     !(cfg->auto_loose_max_raw_ratio >= 0.0 &&
       cfg->auto_loose_max_raw_ratio <= 1.0)) {
    cfg_err(err, err_size, "a savings ratio in the profile is out of range");
    return -1;
  }
  if(cfg->auto_loose_sample_blocks < 1 || cfg->auto_loose_sample_blocks > 4096 ||
     cfg->auto_loose_sample_bytes < 1) {
    cfg_err(err, err_size, "auto-loose sampling settings are out of range");
    return -1;
  }
  if(!safe_relative_name(cfg->index_name)) {
    cfg_err(err, err_size, "unsafe index_name: %s", cfg->index_name);
    return -1;
  }
  if(render_pack_pattern(cfg->pack_pattern, "g", 0, 0, 0, rendered,
                         sizeof(rendered), glob, sizeof(glob)) != 0 ||
     !safe_relative_name(rendered)) {
    cfg_err(err, err_size, "unsafe or invalid pack_pattern: %s",
            cfg->pack_pattern);
    return -1;
  }
  const char *g = glob;
  while(*g == '/') g++;
  if(!*g) {
    cfg_err(err, err_size, "pack_pattern cannot be empty");
    return -1;
  }
  snprintf(cfg->pack_output_glob, sizeof(cfg->pack_output_glob), "%s", g);

  if(ap_config_find_group(cfg, "default") < 0 &&
     config_add_group(cfg, "default", NULL) != 0) {
    cfg_err(err, err_size, "out of memory");
    return -1;
  }
  if(cfg->group_count > 256) {
    cfg_err(err, err_size, "at most 256 packing groups are supported");
    return -1;
  }
  for(size_t i = 0; i < cfg->group_count; i++) {
    ap_group_t *grp = &cfg->groups[i];
    uint32_t page = grp->io_page_size ? grp->io_page_size : io;
    if(grp->pack_count < 1 || grp->pack_count > 0xFFFF) {
      cfg_err(err, err_size, "groups.%s.pack_count must be between 1 and 65535",
              grp->name);
      return -1;
    }
    if(page < (1u << AP_MIN_IO_PAGE_SHIFT) || page > (1u << AP_MAX_IO_PAGE_SHIFT) ||
       (page & (page - 1)) || page % ca) {
      cfg_err(err, err_size, "groups.%s.io_page_size is invalid", grp->name);
      return -1;
    }
    uint64_t align = pa > page ? pa : page;
    uint64_t min_payload = (64 + align - 1) & ~(align - 1);
    if(grp->max_pack_size && grp->max_pack_size < min_payload + page) {
      cfg_err(err, err_size, "groups.%s.max_pack_size is too small", grp->name);
      return -1;
    }
    if(grp->stripe_group_blocks < 1) {
      cfg_err(err, err_size, "groups.%s.stripe_group_blocks must be at least 1",
              grp->name);
      return -1;
    }
  }
  /* packing_class = sorted(config.groups).index(group) */
  ap_group_t **sorted = calloc(cfg->group_count, sizeof(*sorted));
  if(!sorted) {
    cfg_err(err, err_size, "out of memory");
    return -1;
  }
  for(size_t i = 0; i < cfg->group_count; i++) sorted[i] = &cfg->groups[i];
  qsort(sorted, cfg->group_count, sizeof(*sorted), cmp_group_names);
  for(size_t i = 0; i < cfg->group_count; i++) sorted[i]->packing_class = (uint8_t)i;
  free(sorted);

  for(size_t i = 0; i < cfg->rule_count; i++) {
    ap_rule_t *r = &cfg->rules[i];
    if(r->group < 0) r->group = ap_config_find_group(cfg, "default");
    if(r->include.count == 0) {
      cfg_err(err, err_size, "rule %zu include list cannot be empty", i);
      return -1;
    }
    if(r->level < 1 || r->level > 12 || r->acceleration < 1 ||
       !(r->min_savings_ratio >= 0.0 && r->min_savings_ratio < 1.0) ||
       !(r->io_neutral_min_savings_ratio >= 0.0 &&
         r->io_neutral_min_savings_ratio < 1.0)) {
      cfg_err(err, err_size, "rule %zu has out-of-range compression settings", i);
      return -1;
    }
  }
  if(cfg->has_runtime && !cfg->runtime_auto_budget) {
    if(cfg->rt_workers < 1 || cfg->rt_workers > 16 ||
       cfg->rt_latency_reserve_workers >= cfg->rt_workers) {
      cfg_err(err, err_size, "runtime workers must be 1..16 and reserve must be smaller");
      return -1;
    }
    if(cfg->rt_decoded_cache_bytes % 16384 || cfg->rt_physical_cache_bytes % 16384) {
      cfg_err(err, err_size, "runtime cache sizes must be 16 KiB multiples");
      return -1;
    }
  }
  return 0;
}

int
ap_rule_resolved_layout(const ap_rule_t *rule) {
  if(rule->layout != AP_LAYOUT_AUTO) return rule->layout;
  if(rule->streaming) return AP_LAYOUT_STREAMING;
  if(rule->hot) return AP_LAYOUT_RANDOM;
  return AP_LAYOUT_MIXED;
}

const ap_rule_t *
ap_config_select_rule(const ap_config_t *cfg, const char *rel,
                      ap_rule_t *scratch) {
  const ap_rule_t *selected = NULL;
  for(size_t i = 0; i < cfg->rule_count; i++) {
    const ap_rule_t *r = &cfg->rules[i];
    if(ap_glob_matches(rel, &r->include) && !ap_glob_matches(rel, &r->exclude)) {
      selected = r;
    }
  }
  if(selected) return selected;
  memset(scratch, 0, sizeof(*scratch));
  scratch->action = cfg->default_action;
  scratch->block_shift = cfg->default_block_shift;
  scratch->group = ap_config_find_group(cfg, "default");
  scratch->mode_hc = cfg->mode_hc;
  scratch->level = cfg->level;
  scratch->acceleration = cfg->acceleration;
  scratch->min_savings_bytes = cfg->min_savings_bytes;
  scratch->min_savings_ratio = cfg->min_savings_ratio;
  scratch->io_neutral_min_savings_bytes = cfg->io_neutral_min_savings_bytes;
  scratch->io_neutral_min_savings_ratio = cfg->io_neutral_min_savings_ratio;
  scratch->layout = AP_LAYOUT_AUTO;
  return scratch;
}

/* ------------------------------------------------------- toml loader */

#define TOML_FIELD(expr, name) do { \
    int frc__ = (expr); \
    if(frc__ < 0) { cfg_err(err, err_size, "profile: bad value for %s", name); goto fail; } \
  } while(0)

static int
parse_action(const char *s, int *out) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%s", s);
  lower_inplace(buf);
  if(!strcmp(buf, "compress")) *out = AP_ACTION_COMPRESS;
  else if(!strcmp(buf, "store")) *out = AP_ACTION_STORE;
  else if(!strcmp(buf, "loose")) *out = AP_ACTION_LOOSE;
  else return -1;
  return 0;
}

static int
parse_layout(const char *s, int *out) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%s", s);
  lower_inplace(buf);
  if(!strcmp(buf, "auto")) *out = AP_LAYOUT_AUTO;
  else if(!strcmp(buf, "random")) *out = AP_LAYOUT_RANDOM;
  else if(!strcmp(buf, "mixed")) *out = AP_LAYOUT_MIXED;
  else if(!strcmp(buf, "streaming")) *out = AP_LAYOUT_STREAMING;
  else return -1;
  return 0;
}

static int
parse_mode(const char *s, int *hc_out) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%s", s);
  lower_inplace(buf);
  if(!strcmp(buf, "hc")) *hc_out = 1;
  else if(!strcmp(buf, "fast")) *hc_out = 0;
  else return -1;
  return 0;
}

/* include_from/exclude_from: relative files next to the TOML. */
static int
load_pattern_files(const ap_tval_t *v, const char *dir, ap_strlist_t *out,
                   char *err, size_t err_size) {
  ap_strlist_t names = {0};
  int rc = -1;
  int frc = tv_strlist(v, &names);
  if(frc > 0) return 0;
  if(frc < 0) {
    cfg_err(err, err_size, "profile: include_from/exclude_from must be strings");
    goto done;
  }
  for(size_t i = 0; i < names.count; i++) {
    char path[1024];
    if(!safe_relative_name(names.items[i])) {
      cfg_err(err, err_size, "profile: unsafe pattern file %s", names.items[i]);
      goto done;
    }
    if(snprintf(path, sizeof(path), "%s/%s", dir, names.items[i]) >= (int)sizeof(path)) {
      cfg_err(err, err_size, "profile: pattern file path too long");
      goto done;
    }
    FILE *f = fopen(path, "r");
    if(!f) {
      cfg_err(err, err_size, "profile: cannot open %s", names.items[i]);
      goto done;
    }
    char line[1024];
    while(fgets(line, sizeof(line), f)) {
      char *s = line;
      while(*s && isspace((unsigned char)*s)) s++;
      size_t n = strlen(s);
      while(n && isspace((unsigned char)s[n - 1])) s[--n] = 0;
      if(!n || s[0] == '#') continue;
      if(ap_strlist_add(out, s) != 0) {
        fclose(f);
        cfg_err(err, err_size, "out of memory");
        goto done;
      }
    }
    fclose(f);
  }
  rc = 0;
done:
  ap_strlist_free(&names);
  return rc;
}

int
ap_config_load_toml(ap_config_t *cfg, const char *path, int override_level,
                    int override_workers, char *err, size_t err_size) {
  char dir[1024];
  char str[256];
  uint64_t size;
  int64_t ival;
  ap_tval_t *root = ap_toml_parse_file(path, err, err_size);
  if(!root) return -1;
  snprintf(dir, sizeof(dir), "%s", path);
  char *slash = strrchr(dir, '/');
  if(slash) *slash = 0;
  else snprintf(dir, sizeof(dir), "%s", ".");

  const ap_tval_t *pack = ap_toml_get(root, "pack");
  static const ap_tval_t empty_table = { .type = AP_TV_TABLE };
  if(!pack) pack = &empty_table;
  if(pack->type != AP_TV_TABLE) {
    cfg_err(err, err_size, "profile: [pack] must be a table");
    goto fail;
  }

  /* [runtime] */
  const ap_tval_t *rt = ap_toml_get(root, "runtime");
  if(rt) {
    uint64_t dec = 0, phys = 0;
    int64_t w = 0, r = 0;
    if(rt->type != AP_TV_TABLE ||
       tv_size(ap_toml_get(rt, "decoded_cache_bytes"), &dec) != 0 ||
       tv_size(ap_toml_get(rt, "physical_cache_bytes"), &phys) != 0 ||
       tv_int(ap_toml_get(rt, "workers"), &w) != 0 ||
       tv_int(ap_toml_get(rt, "latency_reserve_workers"), &r) != 0) {
      cfg_err(err, err_size, "profile: [runtime] needs decoded_cache_bytes, physical_cache_bytes, workers and latency_reserve_workers");
      goto fail;
    }
    if(w < 1 || w > 16 || r < 0 || r >= w) {
      cfg_err(err, err_size, "profile: runtime workers must be 1..16 and reserve must be smaller");
      goto fail;
    }
    cfg->has_runtime = 1;
    cfg->runtime_auto_budget = 0;
    cfg->rt_decoded_cache_bytes = dec;
    cfg->rt_physical_cache_bytes = phys;
    cfg->rt_workers = (uint32_t)w;
    cfg->rt_latency_reserve_workers = (uint32_t)r;
  }

  /* [pack] */
  TOML_FIELD(tv_string(ap_toml_get(pack, "index_name"), cfg->index_name,
                       sizeof(cfg->index_name)), "index_name");
  TOML_FIELD(tv_string(ap_toml_get(pack, "pack_pattern"), cfg->pack_pattern,
                       sizeof(cfg->pack_pattern)), "pack_pattern");
  if(tv_string(ap_toml_get(pack, "default_action"), str, sizeof(str)) == 0) {
    TOML_FIELD(parse_action(str, &cfg->default_action), "default_action");
  }
  size = 0;
  if(tv_size(ap_toml_get(pack, "default_block_size"), &size) == 0) {
    TOML_FIELD(ap_block_shift_from_size(size, &cfg->default_block_shift),
               "default_block_size");
  }
  size = cfg->io_page_size;
  TOML_FIELD(tv_size(ap_toml_get(pack, "io_page_size"), &size), "io_page_size");
  if(size > 0xFFFFFFFFULL) size = 0;
  cfg->io_page_size = (uint32_t)size;
  size = cfg->io_page_size; /* payload_alignment defaults to io_page_size */
  TOML_FIELD(tv_size(ap_toml_get(pack, "payload_alignment"), &size),
             "payload_alignment");
  cfg->payload_alignment = size > 0xFFFFFFFFULL ? 0 : (uint32_t)size;
  size = cfg->chunk_alignment;
  TOML_FIELD(tv_size(ap_toml_get(pack, "chunk_alignment"), &size),
             "chunk_alignment");
  cfg->chunk_alignment = size > 0xFFFFFFFFULL ? 0 : (uint32_t)size;
  ival = cfg->workers;
  TOML_FIELD(tv_int(ap_toml_get(pack, "workers"), &ival), "workers");
  cfg->workers = (int)ival;
  if(tv_string(ap_toml_get(pack, "compression_mode"), str, sizeof(str)) == 0) {
    TOML_FIELD(parse_mode(str, &cfg->mode_hc), "compression_mode");
  }
  ival = cfg->level;
  TOML_FIELD(tv_int(ap_toml_get(pack, "compression_level"), &ival),
             "compression_level");
  cfg->level = (int)ival;
  ival = cfg->acceleration;
  TOML_FIELD(tv_int(ap_toml_get(pack, "acceleration"), &ival), "acceleration");
  cfg->acceleration = (int)ival;
  TOML_FIELD(tv_size(ap_toml_get(pack, "min_savings_bytes"),
                     &cfg->min_savings_bytes), "min_savings_bytes");
  TOML_FIELD(tv_float(ap_toml_get(pack, "min_savings_ratio"),
                      &cfg->min_savings_ratio), "min_savings_ratio");
  TOML_FIELD(tv_size(ap_toml_get(pack, "io_neutral_min_savings_bytes"),
                     &cfg->io_neutral_min_savings_bytes),
             "io_neutral_min_savings_bytes");
  TOML_FIELD(tv_float(ap_toml_get(pack, "io_neutral_min_savings_ratio"),
                      &cfg->io_neutral_min_savings_ratio),
             "io_neutral_min_savings_ratio");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "deduplicate"), &cfg->deduplicate),
             "deduplicate");
  if(tv_string(ap_toml_get(pack, "deduplicate_scope"), str, sizeof(str)) == 0) {
    lower_inplace(str);
    if(!strcmp(str, "group")) cfg->dedupe_scope_group = 1;
    else if(!strcmp(str, "lane")) cfg->dedupe_scope_group = 0;
    else {
      cfg_err(err, err_size, "profile: deduplicate_scope must be lane or group");
      goto fail;
    }
  }
  TOML_FIELD(tv_bool(ap_toml_get(pack, "deduplicate_streaming"),
                     &cfg->deduplicate_streaming), "deduplicate_streaming");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "preserve_mtime"), &cfg->preserve_mtime),
             "preserve_mtime");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "validate_index_metadata"),
                     &cfg->validate_index_metadata), "validate_index_metadata");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "self_contained"), &cfg->self_contained),
             "self_contained");
  TOML_FIELD(tv_strlist(ap_toml_get(pack, "required_packed"),
                        &cfg->required_packed), "required_packed");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "auto_loose_large_files"),
                     &cfg->auto_loose_large_files), "auto_loose_large_files");
  TOML_FIELD(tv_bool(ap_toml_get(pack, "auto_loose_hot_files"),
                     &cfg->auto_loose_hot_files), "auto_loose_hot_files");
  TOML_FIELD(tv_size(ap_toml_get(pack, "auto_loose_min_file_size"),
                     &cfg->auto_loose_min_file_size), "auto_loose_min_file_size");
  ival = cfg->auto_loose_sample_blocks;
  TOML_FIELD(tv_int(ap_toml_get(pack, "auto_loose_sample_blocks"), &ival),
             "auto_loose_sample_blocks");
  cfg->auto_loose_sample_blocks = ival < 0 ? 0 : (uint32_t)ival;
  TOML_FIELD(tv_size(ap_toml_get(pack, "auto_loose_sample_bytes"),
                     &cfg->auto_loose_sample_bytes), "auto_loose_sample_bytes");
  TOML_FIELD(tv_float(ap_toml_get(pack, "auto_loose_min_savings_ratio"),
                      &cfg->auto_loose_min_savings_ratio),
             "auto_loose_min_savings_ratio");
  TOML_FIELD(tv_float(ap_toml_get(pack, "auto_loose_max_raw_ratio"),
                      &cfg->auto_loose_max_raw_ratio), "auto_loose_max_raw_ratio");
  /* The chosen level and workers replace [pack] compression_level/workers,
   * so rules without their own level inherit the override. */
  if(override_level > 0) cfg->level = override_level;
  if(override_workers > 0) cfg->workers = override_workers;

  /* [groups.*] */
  const ap_tval_t *groups = ap_toml_get(root, "groups");
  if(groups) {
    if(groups->type != AP_TV_TABLE) {
      cfg_err(err, err_size, "profile: [groups] must be a table");
      goto fail;
    }
    for(size_t i = 0; i < groups->kv_count; i++) {
      const ap_tval_t *gv = groups->kvs[i].val;
      ap_group_t *grp = NULL;
      if(gv->type != AP_TV_TABLE) {
        cfg_err(err, err_size, "profile: [groups.%s] must be a table",
                groups->kvs[i].key);
        goto fail;
      }
      if(config_add_group(cfg, groups->kvs[i].key, &grp) != 0) {
        cfg_err(err, err_size, "profile: bad group name %s", groups->kvs[i].key);
        goto fail;
      }
      ival = grp->pack_count;
      TOML_FIELD(tv_int(ap_toml_get(gv, "pack_count"), &ival), "pack_count");
      if(ival < 1 || ival > 0xFFFF) {
        cfg_err(err, err_size, "profile: groups.%s.pack_count must be 1..65535",
                grp->name);
        goto fail;
      }
      grp->pack_count = (uint32_t)ival;
      if(tv_string(ap_toml_get(gv, "assignment"), str, sizeof(str)) == 0) {
        lower_inplace(str);
        if(!strcmp(str, "balanced")) grp->assignment = AP_ASSIGN_BALANCED;
        else if(!strcmp(str, "hash")) grp->assignment = AP_ASSIGN_HASH;
        else if(!strcmp(str, "round_robin")) grp->assignment = AP_ASSIGN_ROUND_ROBIN;
        else {
          cfg_err(err, err_size, "profile: bad assignment for group %s", grp->name);
          goto fail;
        }
      }
      TOML_FIELD(tv_size(ap_toml_get(gv, "max_pack_size"), &grp->max_pack_size),
                 "max_pack_size");
      TOML_FIELD(tv_bool(ap_toml_get(gv, "stripe_large_files"),
                         &grp->stripe_large_files), "stripe_large_files");
      TOML_FIELD(tv_size(ap_toml_get(gv, "stripe_threshold"),
                         &grp->stripe_threshold), "stripe_threshold");
      ival = grp->stripe_group_blocks;
      TOML_FIELD(tv_int(ap_toml_get(gv, "stripe_group_blocks"), &ival),
                 "stripe_group_blocks");
      grp->stripe_group_blocks = ival < 0 ? 0 : (uint32_t)ival;
      size = 0;
      TOML_FIELD(tv_size(ap_toml_get(gv, "io_page_size"), &size), "io_page_size");
      grp->io_page_size = size > 0xFFFFFFFFULL ? 1 : (uint32_t)size;
    }
  }
  if(ap_config_find_group(cfg, "default") < 0 &&
     config_add_group(cfg, "default", NULL) != 0) {
    cfg_err(err, err_size, "out of memory");
    goto fail;
  }

  /* [[rule]] */
  const ap_tval_t *rules = ap_toml_get(root, "rule");
  if(rules) {
    if(rules->type != AP_TV_ARRAY || !rules->table_array) {
      cfg_err(err, err_size, "profile: [[rule]] entries must form an array");
      goto fail;
    }
    for(size_t i = 0; i < rules->count; i++) {
      const ap_tval_t *rv = rules->items[i];
      ap_rule_t *rule = config_add_rule(cfg);
      ap_strlist_t from = {0};
      if(!rule) {
        cfg_err(err, err_size, "out of memory");
        goto fail;
      }
      if(tv_string(ap_toml_get(rv, "group"), str, sizeof(str)) == 0) {
        rule->group = ap_config_find_group(cfg, str);
        if(rule->group < 0) {
          cfg_err(err, err_size, "profile: rule %zu references unknown group %s",
                  i, str);
          goto fail;
        }
      } else {
        rule->group = ap_config_find_group(cfg, "default");
      }
      size = 0;
      if(tv_size(ap_toml_get(rv, "block_size"), &size) == 0) {
        if(ap_block_shift_from_size(size, &rule->block_shift) != 0) {
          cfg_err(err, err_size, "profile: rule %zu block_size must be a power of two from 16 KiB to 1 MiB", i);
          goto fail;
        }
      }
      if(load_pattern_files(ap_toml_get(rv, "include_from"), dir, &from,
                            err, err_size) != 0) {
        ap_strlist_free(&from);
        goto fail;
      }
      int inc_rc = tv_strlist(ap_toml_get(rv, "include"), &rule->include);
      if(inc_rc < 0) {
        ap_strlist_free(&from);
        cfg_err(err, err_size, "profile: rule %zu include must be strings", i);
        goto fail;
      }
      const ap_tval_t *from_names = ap_toml_get(rv, "include_from");
      int has_from_names = from_names &&
          (from_names->type == AP_TV_STRING ||
           (from_names->type == AP_TV_ARRAY && from_names->count > 0));
      if(inc_rc > 0 && !has_from_names &&
         ap_strlist_add(&rule->include, "**") != 0) {
        ap_strlist_free(&from);
        cfg_err(err, err_size, "out of memory");
        goto fail;
      }
      if(strlist_copy(&rule->include, &from) != 0) {
        ap_strlist_free(&from);
        cfg_err(err, err_size, "out of memory");
        goto fail;
      }
      ap_strlist_free(&from);
      if(tv_strlist(ap_toml_get(rv, "exclude"), &rule->exclude) < 0 ||
         load_pattern_files(ap_toml_get(rv, "exclude_from"), dir,
                            &rule->exclude, err, err_size) != 0) {
        cfg_err(err, err_size, "profile: rule %zu exclude is invalid", i);
        goto fail;
      }
      if(tv_string(ap_toml_get(rv, "action"), str, sizeof(str)) == 0 &&
         parse_action(str, &rule->action) != 0) {
        cfg_err(err, err_size, "profile: rule %zu has a bad action", i);
        goto fail;
      }
      if(tv_string(ap_toml_get(rv, "compression_mode"), str, sizeof(str)) == 0 &&
         parse_mode(str, &rule->mode_hc) != 0) {
        cfg_err(err, err_size, "profile: rule %zu compression_mode must be fast or hc", i);
        goto fail;
      }
      ival = rule->level;
      TOML_FIELD(tv_int(ap_toml_get(rv, "compression_level"), &ival),
                 "compression_level");
      rule->level = (int)ival;
      ival = rule->acceleration;
      TOML_FIELD(tv_int(ap_toml_get(rv, "acceleration"), &ival), "acceleration");
      rule->acceleration = (int)ival;
      TOML_FIELD(tv_size(ap_toml_get(rv, "min_savings_bytes"),
                         &rule->min_savings_bytes), "min_savings_bytes");
      TOML_FIELD(tv_float(ap_toml_get(rv, "min_savings_ratio"),
                          &rule->min_savings_ratio), "min_savings_ratio");
      TOML_FIELD(tv_size(ap_toml_get(rv, "io_neutral_min_savings_bytes"),
                         &rule->io_neutral_min_savings_bytes),
                 "io_neutral_min_savings_bytes");
      TOML_FIELD(tv_float(ap_toml_get(rv, "io_neutral_min_savings_ratio"),
                          &rule->io_neutral_min_savings_ratio),
                 "io_neutral_min_savings_ratio");
      if(tv_string(ap_toml_get(rv, "layout"), str, sizeof(str)) == 0 &&
         parse_layout(str, &rule->layout) != 0) {
        cfg_err(err, err_size, "profile: rule %zu has a bad layout", i);
        goto fail;
      }
      TOML_FIELD(tv_bool(ap_toml_get(rv, "streaming"), &rule->streaming),
                 "streaming");
      TOML_FIELD(tv_bool(ap_toml_get(rv, "hot"), &rule->hot), "hot");
      TOML_FIELD(tv_bool(ap_toml_get(rv, "force_pack"), &rule->force_pack),
                 "force_pack");
    }
  }
  ap_toml_free(root);
  snprintf(cfg->source, sizeof(cfg->source), "%s", "profile");
  return 0;

fail:
  if(err && err_size && !err[0]) {
    snprintf(err, err_size, "%s", "profile is invalid");
  }
  ap_toml_free(root);
  return -1;
}

/* -------------------------------------------------- universal profile */

static const char *const k_safety_exclusions[] = {
  "eboot.bin", "**/eboot.bin",
  "*.elf", "**/*.elf",
  "*.self", "**/*.self",
  "*.prx", "**/*.prx",
  "*.sprx", "**/*.sprx",
  "*.bak", "**/*.bak",
  "*.dat", "**/*.dat",
  "*.utoc", "**/*.utoc",
  "decrypted/**",
  "sce_module/**", "**/sce_module/**",
  "sce_sys/**", "**/sce_sys/**",
  "system/**", "**/system/**",
  "mods/**", "**/mods/**",
  "save/**", "**/save/**",
  "fakelib/**", "**/fakelib/**",
  "_DUPLEX_/**",
  "trophy2/**", "**/trophy2/**",
  "uds/**", "**/uds/**",
  "ampr_emu.index", "**/ampr_emu.index",
  "ampr_assets.index", "**/ampr_assets.index",
  "ampr_assets.index.crc", "**/ampr_assets.index.crc",
  "ampr_assets.index.runtime", "**/ampr_assets.index.runtime",
  "ampr_assets-*.pak", "**/*.pak",
  "*.json", "**/*.json",
  "*.ini", "**/*.ini",
  "*.cfg", "**/*.cfg",
  "*.xml", "**/*.xml",
  "*.txt", "**/*.txt",
  "*.bk2", "**/*.bk2",
  "*.mp4", "**/*.mp4",
  "*.ivf", "**/*.ivf",
  "*.usm", "**/*.usm",
  "*.bnk", "**/*.bnk",
  "*.wem", "**/*.wem",
  "*.at9", "**/*.at9",
  "*.pfs", "**/*.pfs",
  "*.img", "**/*.img",
  "*.png", "**/*.png",
  "*.jpg", "**/*.jpg",
  "*.jpeg", "**/*.jpeg",
  "*.webp", "**/*.webp",
  "*.gif", "**/*.gif",
  "*.bmp", "**/*.bmp",
  "*.ico", "**/*.ico",
  "*.tga", "**/*.tga",
  "*.tif", "**/*.tif",
  "*.tiff", "**/*.tiff",
  "*.exr", "**/*.exr",
  "*.hdr", "**/*.hdr",
  "*.psd", "**/*.psd",
  "*.dds", "**/*.dds",
  "*.ktx", "**/*.ktx",
  "*.ktx2", "**/*.ktx2",
  "*.astc", "**/*.astc",
  "*.basis", "**/*.basis",
  "*.gnf", "**/*.gnf",
  "*.gnfp", "**/*.gnfp",
  "*.jxm", "**/*.jxm",
  "*.vtf", "**/*.vtf",
  "*.zip", "**/*.zip",
  "*.7z", "**/*.7z",
  "*.rar", "**/*.rar",
  "*.gz", "**/*.gz",
  "*.xz", "**/*.xz",
  "*.bz2", "**/*.bz2",
  "*.zst", "**/*.zst",
  "*.lz4", "**/*.lz4",
  "*.mp3", "**/*.mp3",
  "*.ogg", "**/*.ogg",
  "*.flac", "**/*.flac",
  "*.aac", "**/*.aac",
  "*.opus", "**/*.opus",
  "*.m4a", "**/*.m4a",
  "*.avi", "**/*.avi",
  "*.mkv", "**/*.mkv",
  "*.mov", "**/*.mov",
  "*.wmv", "**/*.wmv",
  "*.flv", "**/*.flv",
  "*.webm", "**/*.webm",
  "*.m4v", "**/*.m4v",
};

#define SAFETY_COUNT (sizeof(k_safety_exclusions) / sizeof(k_safety_exclusions[0]))

static int
is_safety_pattern(const char *p) {
  for(size_t i = 0; i < SAFETY_COUNT; i++) {
    if(!strcmp(k_safety_exclusions[i], p)) return 1;
  }
  return 0;
}

int
ap_config_add_safety_exclusions(ap_config_t *cfg) {
  for(size_t i = 0; i < SAFETY_COUNT; i++) {
    if(!ap_strlist_contains(&cfg->force_loose, k_safety_exclusions[i]) &&
       ap_strlist_add(&cfg->force_loose, k_safety_exclusions[i]) != 0) {
      return -1;
    }
  }
  return 0;
}

static int
contains_ci_hint(const char *name, const char *const *hints, size_t count) {
  char lower[256];
  snprintf(lower, sizeof(lower), "%s", name);
  lower_inplace(lower);
  for(size_t i = 0; i < count; i++) {
    if(strstr(lower, hints[i])) return 1;
  }
  return 0;
}

/* Path.suffix.lower() */
static void
path_suffix_lower(const char *rel, char *out, size_t out_size) {
  const char *base = strrchr(rel, '/');
  base = base ? base + 1 : rel;
  const char *dot = strrchr(base, '.');
  out[0] = 0;
  if(!dot || dot == base || dot[1] == 0) return;
  snprintf(out, out_size, "%s", dot);
  lower_inplace(out);
}

static int
is_alpha_us(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

static int
is_digit_c(char c) {
  return c >= '0' && c <= '9';
}

/* Root "numbered" data files: data.0, chunk0.bin, file.001. */
static int
root_numbered_name(const char *n) {
  size_t i = 0;
  size_t len = strlen(n);
  while(i < len && is_alpha_us(n[i])) i++;
  if(i == 0) return 0;
  /* ^[a-zA-Z_]+\.\d+$ (also covers \.\d{2,}) */
  if(n[i] == '.') {
    size_t j = i + 1;
    while(j < len && is_digit_c(n[j])) j++;
    if(j > i + 1 && j == len) return 1;
  }
  /* ^[a-zA-Z_]+\d+\.[a-zA-Z]+$ */
  size_t j = i;
  while(j < len && is_digit_c(n[j])) j++;
  if(j == i || n[j] != '.') return 0;
  size_t k = j + 1;
  while(k < len && ((n[k] >= 'a' && n[k] <= 'z') || (n[k] >= 'A' && n[k] <= 'Z'))) k++;
  return k > j + 1 && k == len;
}

static int
cmp_str(const void *a, const void *b) {
  return strcmp(*(const char *const *)a, *(const char *const *)b);
}

static int
add_rule_patterns(ap_rule_t *r, const char *const *pats, size_t count) {
  for(size_t i = 0; i < count; i++) {
    if(ap_strlist_add(&r->include, pats[i]) != 0) return -1;
  }
  return 0;
}

/* Loose patterns learned from uploaded profiles, filtered for this game. */
static int
collect_learned_patterns(const char *learn_dir, const ap_scan_t *scan,
                         ap_strlist_t *out) {
  ap_strlist_t all = {0};
  DIR *d;
  struct dirent *ent;
  if(!learn_dir || !learn_dir[0]) return 0;
  d = opendir(learn_dir);
  if(!d) return 0;
  while((ent = readdir(d)) != NULL) {
    size_t n = strlen(ent->d_name);
    char path[1024];
    char perr[128] = {0};
    struct stat st;
    if(ent->d_name[0] == '.') continue;
    /* Profiles live either flat (<name>.toml) or per title
     * (<TITLE_ID>/profile.toml beside its include lists). */
    if(n >= 6 && !strcasecmp(ent->d_name + n - 5, ".toml")) {
      if(snprintf(path, sizeof(path), "%s/%s", learn_dir, ent->d_name) >=
         (int)sizeof(path)) {
        continue;
      }
    } else if(snprintf(path, sizeof(path), "%s/%s/profile.toml", learn_dir,
                       ent->d_name) >= (int)sizeof(path) ||
              stat(path, &st) != 0 || !S_ISREG(st.st_mode)) {
      continue;
    }
    ap_tval_t *root = ap_toml_parse_file(path, perr, sizeof(perr));
    if(!root) continue;
    const ap_tval_t *rules = ap_toml_get(root, "rule");
    if(rules && rules->type == AP_TV_ARRAY && rules->table_array) {
      for(size_t i = 0; i < rules->count; i++) {
        const ap_tval_t *action = ap_toml_get(rules->items[i], "action");
        if(!action || action->type != AP_TV_STRING ||
           strcmp(action->s, "loose")) {
          continue;
        }
        ap_strlist_t inc = {0};
        if(tv_strlist(ap_toml_get(rules->items[i], "include"), &inc) == 0) {
          for(size_t k = 0; k < inc.count; k++) {
            char trimmed[512];
            const char *s = inc.items[k];
            while(*s && isspace((unsigned char)*s)) s++;
            snprintf(trimmed, sizeof(trimmed), "%s", s);
            size_t tl = strlen(trimmed);
            while(tl && isspace((unsigned char)trimmed[tl - 1])) trimmed[--tl] = 0;
            if(tl && !ap_strlist_contains(&all, trimmed)) {
              (void)ap_strlist_add(&all, trimmed);
            }
          }
        }
        ap_strlist_free(&inc);
      }
    }
    ap_toml_free(root);
  }
  closedir(d);

  for(size_t i = 0; i < all.count; i++) {
    const char *pat = all.items[i];
    int matched = 0;
    if(is_safety_pattern(pat)) continue;
    for(size_t f = 0; !matched && f < scan->file_count; f++) {
      matched = ap_segment_glob_match(pat, scan->files[f].rel);
    }
    for(size_t dd = 0; !matched && dd < scan->dirs.count; dd++) {
      matched = ap_segment_glob_match(pat, scan->dirs.items[dd]);
    }
    if(matched && ap_strlist_add(out, pat) != 0) {
      ap_strlist_free(&all);
      return -1;
    }
  }
  ap_strlist_free(&all);
  return 0;
}

int
ap_config_build_universal(ap_config_t *cfg, const ap_scan_t *scan,
                          int level, int block_shift, int workers,
                          int auto_loose_large, const char *learn_dir,
                          char *err, size_t err_size) {
  static const char *const streaming_hints[] = {
    "video", "movie", "movies", "cutscene", "cutscenes", "fmv",
    "cinematic", "cinematics",
  };
  static const char *const audio_hints[] = {
    "sound", "audio", "sfx", "music", "voice", "vo", "dialog", "dialogue",
    "soundbank", "wem",
  };
  static const char *const texture_exts[] = {
    ".dds", ".ktx", ".ktx2", ".astc", ".basis", ".tga", ".gnf", ".gnfp",
    ".jxm", ".vtf", ".dat", ".res", ".uasset", ".ubulk", ".bin",
  };
  static const char *const audio_globs[] = {
    "**/sound/**", "**/audio/**", "**/sfx/**", "**/music/**", "**/voice/**",
    "**/vo/**", "**/dialog/**", "**/dialogue/**",
  };
  static const char *const video_globs[] = {
    "**/video/**", "**/movie/**", "**/movies/**", "**/cutscene/**",
    "**/cutscenes/**", "**/fmv/**", "**/cinematic/**", "**/cinematics/**",
  };
  static const char *const streaming_containers[] = {
    "**/movie", "**/movie_*", "**/movies", "**/movies_*",
    "**/soundbank", "**/soundbank_*",
    "**/screenreaderwem", "**/screenreaderwem.*",
    "**/wem", "**/wem_*", "**/wem.*",
  };
  int has_subdirs = scan->dirs.count > 0;
  int has_audio = 0;
  int has_video = 0;
  int has_soundbank_ext = 0;
  int texture_found[sizeof(texture_exts) / sizeof(texture_exts[0])] = {0};
  ap_strlist_t numbered = {0};
  ap_strlist_t learned = {0};
  ap_rule_t *r;
  int assets;

  if(level < 1) level = 1;
  if(level > 12) level = 12;
  cfg->mode_hc = level > 4;
  cfg->level = level;
  cfg->acceleration = 1;
  cfg->workers = workers < 1 ? 1 : workers;
  cfg->default_block_shift = block_shift;
  snprintf(cfg->pack_pattern, sizeof(cfg->pack_pattern), "%s",
           "ampr_assets-{group}-lane{lane:02d}-vol{volume:02d}-{id:03d}.pak");
  cfg->auto_loose_large_files = auto_loose_large ? 1 : 0;
  cfg->has_runtime = 1;
  cfg->runtime_auto_budget = 1;
  cfg->rt_workers = 8;
  cfg->rt_latency_reserve_workers = 1;

  for(size_t i = 0; i < scan->dirs.count; i++) {
    char top[256];
    const char *rel = scan->dirs.items[i];
    const char *slash = strchr(rel, '/');
    size_t n = slash ? (size_t)(slash - rel) : strlen(rel);
    if(n >= sizeof(top)) n = sizeof(top) - 1;
    memcpy(top, rel, n);
    top[n] = 0;
    if(contains_ci_hint(top, streaming_hints,
                        sizeof(streaming_hints) / sizeof(streaming_hints[0]))) {
      has_video = 1;
    }
    if(contains_ci_hint(top, audio_hints,
                        sizeof(audio_hints) / sizeof(audio_hints[0]))) {
      has_audio = 1;
    }
  }
  for(size_t i = 0; i < scan->file_count; i++) {
    char ext[64];
    const char *rel = scan->files[i].rel;
    path_suffix_lower(rel, ext, sizeof(ext));
    if(ext[0]) {
      if(strstr(ext, "soundbank")) has_soundbank_ext = 1;
      for(size_t t = 0; t < sizeof(texture_exts) / sizeof(texture_exts[0]); t++) {
        if(!strcmp(ext, texture_exts[t])) texture_found[t] = 1;
      }
    }
    if(!strchr(rel, '/') && root_numbered_name(rel)) {
      if(ap_strlist_add(&numbered, rel) != 0) goto oom;
    }
  }

  ap_group_t *grp = NULL;
  if(config_add_group(cfg, "assets", &grp) != 0) goto oom;
  grp->pack_count = 4;
  grp->assignment = AP_ASSIGN_BALANCED;
  grp->max_pack_size = 16 * GIB;
  grp->stripe_large_files = 0;
  assets = (int)(grp - cfg->groups);

  if(has_subdirs) {
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_COMPRESS;
    if(ap_strlist_add(&r->include, "*/**") != 0) goto oom;
    r->block_shift = block_shift;
    r->group = assets;
    r->layout = AP_LAYOUT_MIXED;
  }
  if(numbered.count) {
    qsort(numbered.items, numbered.count, sizeof(char *), cmp_str);
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_COMPRESS;
    if(add_rule_patterns(r, (const char *const *)numbered.items,
                         numbered.count) != 0) {
      goto oom;
    }
    r->block_shift = block_shift;
    r->group = assets;
    r->layout = AP_LAYOUT_MIXED;
  }
  {
    const char *exts[sizeof(texture_exts) / sizeof(texture_exts[0])];
    size_t n = 0;
    for(size_t t = 0; t < sizeof(texture_exts) / sizeof(texture_exts[0]); t++) {
      if(texture_found[t]) exts[n++] = texture_exts[t];
    }
    if(n) {
      qsort(exts, n, sizeof(exts[0]), cmp_str);
      if(!(r = config_add_rule(cfg))) goto oom;
      r->action = AP_ACTION_COMPRESS;
      for(size_t t = 0; t < n; t++) {
        char pat[64];
        snprintf(pat, sizeof(pat), "**/*%s", exts[t]);
        if(ap_strlist_add(&r->include, pat) != 0) goto oom;
      }
      r->block_shift = block_shift > 16 ? block_shift : 16;
      r->group = assets;
      r->layout = AP_LAYOUT_MIXED;
    }
  }
  if(has_audio) {
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_COMPRESS;
    if(add_rule_patterns(r, audio_globs,
                         sizeof(audio_globs) / sizeof(audio_globs[0])) != 0) {
      goto oom;
    }
    r->block_shift = 14;
    r->group = assets;
    r->layout = AP_LAYOUT_RANDOM;
    r->hot = 1;
    r->min_savings_bytes = 16;
    r->min_savings_ratio = 0.0025;
    r->io_neutral_min_savings_bytes = 2 * KIB;
    r->io_neutral_min_savings_ratio = 0.125;
  }
  if(has_video) {
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_LOOSE;
    if(add_rule_patterns(r, video_globs,
                         sizeof(video_globs) / sizeof(video_globs[0])) != 0) {
      goto oom;
    }
  }
  if(!(r = config_add_rule(cfg))) goto oom;
  r->action = AP_ACTION_LOOSE;
  if(add_rule_patterns(r, streaming_containers,
                       sizeof(streaming_containers) /
                       sizeof(streaming_containers[0])) != 0) {
    goto oom;
  }
  if(has_soundbank_ext) {
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_COMPRESS;
    if(ap_strlist_add(&r->include, "**/soundbank.*") != 0) goto oom;
    r->block_shift = 14;
    r->group = assets;
    r->layout = AP_LAYOUT_RANDOM;
    r->hot = 1;
    r->min_savings_bytes = 16;
    r->min_savings_ratio = 0.0025;
    r->io_neutral_min_savings_bytes = 2 * KIB;
    r->io_neutral_min_savings_ratio = 0.125;
  }
  if(collect_learned_patterns(learn_dir, scan, &learned) != 0) goto oom;
  if(learned.count) {
    if(!(r = config_add_rule(cfg))) goto oom;
    r->action = AP_ACTION_LOOSE;
    if(strlist_copy(&r->include, &learned) != 0) goto oom;
    cfg->learned_patterns = learned.count;
  }
  if(!(r = config_add_rule(cfg))) goto oom;
  r->action = AP_ACTION_LOOSE;
  if(add_rule_patterns(r, k_safety_exclusions, SAFETY_COUNT) != 0) goto oom;
  /* Rules without an explicit group use "default". */
  if(ap_config_find_group(cfg, "default") < 0 &&
     config_add_group(cfg, "default", NULL) != 0) {
    goto oom;
  }
  for(size_t i = 0; i < cfg->rule_count; i++) {
    if(cfg->rules[i].group < 0) {
      cfg->rules[i].group = ap_config_find_group(cfg, "default");
    }
  }
  snprintf(cfg->source, sizeof(cfg->source), "%s", "auto");
  ap_strlist_free(&numbered);
  ap_strlist_free(&learned);
  return 0;

oom:
  ap_strlist_free(&numbered);
  ap_strlist_free(&learned);
  cfg_err(err, err_size, "out of memory");
  errno = ENOMEM;
  return -1;
}
