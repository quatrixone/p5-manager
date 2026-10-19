/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - minimal TOML reader for AMPR pack profiles.
 *
 * Supports the subset that ampr_pack.py and ampr_pack_profile.py emit: tables, dotted table names, arrays of tables, basic and literal
 * strings, integers, floats, booleans and (multi-line) arrays.
 */

#include "ampr_pack_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define AP_TOML_MAX_FILE (8u * 1024u * 1024u)

typedef struct tp {
  const char *p;
  const char *end;
  int line;
  char *err;
  size_t err_size;
} tp_t;

static int
tp_fail(tp_t *t, const char *fmt, ...) {
  if(t->err && t->err_size && !t->err[0]) {
    char msg[192];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    snprintf(t->err, t->err_size, "profile line %d: %s", t->line, msg);
  }
  errno = EINVAL;
  return -1;
}

static ap_tval_t *
tv_new(ap_tval_type_t type) {
  ap_tval_t *v = calloc(1, sizeof(*v));
  if(v) v->type = type;
  return v;
}

void
ap_toml_free(ap_tval_t *v) {
  if(!v) return;
  free(v->s);
  for(size_t i = 0; i < v->count; i++) ap_toml_free(v->items[i]);
  free(v->items);
  for(size_t i = 0; i < v->kv_count; i++) {
    free(v->kvs[i].key);
    ap_toml_free(v->kvs[i].val);
  }
  free(v->kvs);
  free(v);
}

const ap_tval_t *
ap_toml_get(const ap_tval_t *table, const char *key) {
  if(!table || table->type != AP_TV_TABLE || !key) return NULL;
  for(size_t i = 0; i < table->kv_count; i++) {
    if(!strcmp(table->kvs[i].key, key)) return table->kvs[i].val;
  }
  return NULL;
}

static ap_tval_t *
table_get_mut(ap_tval_t *table, const char *key) {
  for(size_t i = 0; i < table->kv_count; i++) {
    if(!strcmp(table->kvs[i].key, key)) return table->kvs[i].val;
  }
  return NULL;
}

static int
table_put(ap_tval_t *table, const char *key, ap_tval_t *val) {
  if(table->kv_count == table->kv_cap) {
    size_t next = table->kv_cap ? table->kv_cap * 2 : 8;
    ap_tkv_t *kvs = realloc(table->kvs, next * sizeof(*kvs));
    if(!kvs) return -1;
    table->kvs = kvs;
    table->kv_cap = next;
  }
  char *k = strdup(key);
  if(!k) return -1;
  table->kvs[table->kv_count].key = k;
  table->kvs[table->kv_count].val = val;
  table->kv_count++;
  return 0;
}

static int
array_push(ap_tval_t *arr, ap_tval_t *item) {
  if(arr->count == arr->cap) {
    size_t next = arr->cap ? arr->cap * 2 : 8;
    ap_tval_t **items = realloc(arr->items, next * sizeof(*items));
    if(!items) return -1;
    arr->items = items;
    arr->cap = next;
  }
  arr->items[arr->count++] = item;
  return 0;
}

static void
skip_ws(tp_t *t) {
  while(t->p < t->end && (*t->p == ' ' || *t->p == '\t')) t->p++;
}

static void
skip_comment(tp_t *t) {
  if(t->p < t->end && *t->p == '#') {
    while(t->p < t->end && *t->p != '\n') t->p++;
  }
}

/* Whitespace, comments and newlines, used inside arrays and between lines. */
static void
skip_ws_nl(tp_t *t) {
  for(;;) {
    skip_ws(t);
    skip_comment(t);
    if(t->p < t->end && (*t->p == '\n' || *t->p == '\r')) {
      if(*t->p == '\n') t->line++;
      t->p++;
      continue;
    }
    break;
  }
}

static int
expect_eol(tp_t *t) {
  skip_ws(t);
  skip_comment(t);
  if(t->p >= t->end) return 0;
  if(*t->p == '\r') t->p++;
  if(t->p < t->end && *t->p == '\n') {
    t->p++;
    t->line++;
    return 0;
  }
  return tp_fail(t, "unexpected text after value");
}

typedef struct sbuf {
  char *d;
  size_t n;
  size_t cap;
} sbuf_t;

static int
sb_put(sbuf_t *b, char c) {
  if(b->n + 2 > b->cap) {
    size_t next = b->cap ? b->cap * 2 : 64;
    char *d = realloc(b->d, next);
    if(!d) return -1;
    b->d = d;
    b->cap = next;
  }
  b->d[b->n++] = c;
  b->d[b->n] = 0;
  return 0;
}

static int
sb_put_utf8(sbuf_t *b, uint32_t cp) {
  if(cp < 0x80) return sb_put(b, (char)cp);
  if(cp < 0x800) {
    return sb_put(b, (char)(0xC0 | (cp >> 6))) ||
           sb_put(b, (char)(0x80 | (cp & 0x3F)));
  }
  if(cp < 0x10000) {
    return sb_put(b, (char)(0xE0 | (cp >> 12))) ||
           sb_put(b, (char)(0x80 | ((cp >> 6) & 0x3F))) ||
           sb_put(b, (char)(0x80 | (cp & 0x3F)));
  }
  if(cp > 0x10FFFF) return -1;
  return sb_put(b, (char)(0xF0 | (cp >> 18))) ||
         sb_put(b, (char)(0x80 | ((cp >> 12) & 0x3F))) ||
         sb_put(b, (char)(0x80 | ((cp >> 6) & 0x3F))) ||
         sb_put(b, (char)(0x80 | (cp & 0x3F)));
}

static int
hexval(char c) {
  if(c >= '0' && c <= '9') return c - '0';
  if(c >= 'a' && c <= 'f') return c - 'a' + 10;
  if(c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static char *
parse_string(tp_t *t) {
  sbuf_t b = {0};
  char quote = *t->p;
  if(t->p + 2 < t->end && t->p[1] == quote && t->p[2] == quote) {
    tp_fail(t, "multi-line strings are not supported");
    return NULL;
  }
  t->p++;
  if(sb_put(&b, 0) != 0) goto oom;
  b.n = 0;
  while(t->p < t->end && *t->p != quote) {
    char c = *t->p;
    if(c == '\n') {
      tp_fail(t, "unterminated string");
      goto fail;
    }
    if(quote == '"' && c == '\\') {
      t->p++;
      if(t->p >= t->end) break;
      char e = *t->p++;
      uint32_t cp = 0;
      int digits = 0;
      switch(e) {
      case 'b': if(sb_put(&b, '\b')) goto oom; continue;
      case 't': if(sb_put(&b, '\t')) goto oom; continue;
      case 'n': if(sb_put(&b, '\n')) goto oom; continue;
      case 'f': if(sb_put(&b, '\f')) goto oom; continue;
      case 'r': if(sb_put(&b, '\r')) goto oom; continue;
      case '"': if(sb_put(&b, '"')) goto oom; continue;
      case '\\': if(sb_put(&b, '\\')) goto oom; continue;
      case 'u': digits = 4; break;
      case 'U': digits = 8; break;
      default:
        tp_fail(t, "bad string escape");
        goto fail;
      }
      for(int i = 0; i < digits; i++) {
        int h = t->p < t->end ? hexval(*t->p) : -1;
        if(h < 0) {
          tp_fail(t, "bad unicode escape");
          goto fail;
        }
        cp = (cp << 4) | (uint32_t)h;
        t->p++;
      }
      if(sb_put_utf8(&b, cp) != 0) {
        tp_fail(t, "bad unicode escape");
        goto fail;
      }
      continue;
    }
    if(sb_put(&b, c) != 0) goto oom;
    t->p++;
  }
  if(t->p >= t->end) {
    tp_fail(t, "unterminated string");
    goto fail;
  }
  t->p++;
  return b.d;
oom:
  tp_fail(t, "out of memory");
fail:
  free(b.d);
  return NULL;
}

static int
is_bare_key_char(char c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
         (c >= '0' && c <= '9') || c == '_' || c == '-';
}

static char *
parse_key_segment(tp_t *t) {
  skip_ws(t);
  if(t->p >= t->end) {
    tp_fail(t, "missing key");
    return NULL;
  }
  if(*t->p == '"' || *t->p == '\'') return parse_string(t);
  const char *start = t->p;
  while(t->p < t->end && is_bare_key_char(*t->p)) t->p++;
  if(t->p == start) {
    tp_fail(t, "bad key");
    return NULL;
  }
  size_t n = (size_t)(t->p - start);
  char *k = malloc(n + 1);
  if(!k) {
    tp_fail(t, "out of memory");
    return NULL;
  }
  memcpy(k, start, n);
  k[n] = 0;
  return k;
}

/* Parses "a.b.c" into segments; caller frees. */
static int
parse_key_path(tp_t *t, char ***segs_out, size_t *count_out) {
  char **segs = NULL;
  size_t count = 0;
  for(;;) {
    char *seg = parse_key_segment(t);
    if(!seg) goto fail;
    char **next = realloc(segs, (count + 1) * sizeof(*next));
    if(!next) {
      free(seg);
      tp_fail(t, "out of memory");
      goto fail;
    }
    segs = next;
    segs[count++] = seg;
    skip_ws(t);
    if(t->p < t->end && *t->p == '.') {
      t->p++;
      continue;
    }
    break;
  }
  *segs_out = segs;
  *count_out = count;
  return 0;
fail:
  for(size_t i = 0; i < count; i++) free(segs[i]);
  free(segs);
  return -1;
}

static void
free_segs(char **segs, size_t count) {
  for(size_t i = 0; i < count; i++) free(segs[i]);
  free(segs);
}

/* Walks to (and creates) an intermediate table. Arrays of tables resolve to
 * their last element, as TOML specifies. */
static ap_tval_t *
descend(tp_t *t, ap_tval_t *table, const char *key) {
  ap_tval_t *v = table_get_mut(table, key);
  if(!v) {
    v = tv_new(AP_TV_TABLE);
    if(!v || table_put(table, key, v) != 0) {
      ap_toml_free(v);
      tp_fail(t, "out of memory");
      return NULL;
    }
    return v;
  }
  if(v->type == AP_TV_TABLE) return v;
  if(v->type == AP_TV_ARRAY && v->table_array && v->count > 0) {
    return v->items[v->count - 1];
  }
  tp_fail(t, "key '%s' is not a table", key);
  return NULL;
}

static ap_tval_t *parse_value(tp_t *t);

static ap_tval_t *
parse_array(tp_t *t) {
  ap_tval_t *arr = tv_new(AP_TV_ARRAY);
  if(!arr) {
    tp_fail(t, "out of memory");
    return NULL;
  }
  t->p++;
  for(;;) {
    skip_ws_nl(t);
    if(t->p >= t->end) {
      tp_fail(t, "unterminated array");
      goto fail;
    }
    if(*t->p == ']') {
      t->p++;
      return arr;
    }
    ap_tval_t *item = parse_value(t);
    if(!item) goto fail;
    if(array_push(arr, item) != 0) {
      ap_toml_free(item);
      tp_fail(t, "out of memory");
      goto fail;
    }
    skip_ws_nl(t);
    if(t->p < t->end && *t->p == ',') {
      t->p++;
      continue;
    }
    skip_ws_nl(t);
    if(t->p < t->end && *t->p == ']') {
      t->p++;
      return arr;
    }
    tp_fail(t, "expected ',' or ']' in array");
    goto fail;
  }
fail:
  ap_toml_free(arr);
  return NULL;
}

static ap_tval_t *
parse_number(tp_t *t) {
  char buf[96];
  size_t n = 0;
  int is_float = 0;
  int hex = 0;
  const char *start = t->p;
  while(t->p < t->end) {
    char c = *t->p;
    if(c == '_') {
      t->p++;
      continue;
    }
    if((c >= '0' && c <= '9') || c == '+' || c == '-' ||
       c == '.' || c == 'e' || c == 'E' ||
       (hex && hexval(c) >= 0) ||
       ((c == 'x' || c == 'X') && n == 1 && buf[0] == '0')) {
      if(c == 'x' || c == 'X') hex = 1;
      if(!hex && (c == '.' || c == 'e' || c == 'E')) is_float = 1;
      if(n + 1 >= sizeof(buf)) break;
      buf[n++] = c;
      t->p++;
      continue;
    }
    break;
  }
  buf[n] = 0;
  if(n == 0 || t->p == start) {
    tp_fail(t, "bad value");
    return NULL;
  }
  char *endp = NULL;
  ap_tval_t *v;
  errno = 0;
  if(is_float) {
    double f = strtod(buf, &endp);
    if(!endp || *endp || errno) {
      tp_fail(t, "bad float");
      return NULL;
    }
    v = tv_new(AP_TV_FLOAT);
    if(v) v->f = f;
  } else {
    long long i = strtoll(buf, &endp, hex ? 16 : 10);
    if(!endp || *endp || errno) {
      tp_fail(t, "bad integer");
      return NULL;
    }
    v = tv_new(AP_TV_INT);
    if(v) v->i = (int64_t)i;
  }
  if(!v) tp_fail(t, "out of memory");
  return v;
}

static ap_tval_t *
parse_value(tp_t *t) {
  skip_ws(t);
  if(t->p >= t->end) {
    tp_fail(t, "missing value");
    return NULL;
  }
  char c = *t->p;
  if(c == '"' || c == '\'') {
    char *s = parse_string(t);
    if(!s) return NULL;
    ap_tval_t *v = tv_new(AP_TV_STRING);
    if(!v) {
      free(s);
      tp_fail(t, "out of memory");
      return NULL;
    }
    v->s = s;
    return v;
  }
  if(c == '[') return parse_array(t);
  if(c == '{') {
    tp_fail(t, "inline tables are not supported");
    return NULL;
  }
  if((size_t)(t->end - t->p) >= 4 && !strncmp(t->p, "true", 4) &&
     (t->p + 4 == t->end || !is_bare_key_char(t->p[4]))) {
    t->p += 4;
    ap_tval_t *v = tv_new(AP_TV_BOOL);
    if(v) v->b = 1;
    return v;
  }
  if((size_t)(t->end - t->p) >= 5 && !strncmp(t->p, "false", 5) &&
     (t->p + 5 == t->end || !is_bare_key_char(t->p[5]))) {
    t->p += 5;
    ap_tval_t *v = tv_new(AP_TV_BOOL);
    if(v) v->b = 0;
    return v;
  }
  return parse_number(t);
}

static int
parse_header(tp_t *t, ap_tval_t *root, ap_tval_t **current) {
  int array_table = 0;
  char **segs = NULL;
  size_t count = 0;
  t->p++;
  if(t->p < t->end && *t->p == '[') {
    array_table = 1;
    t->p++;
  }
  if(parse_key_path(t, &segs, &count) != 0) return -1;
  skip_ws(t);
  if(t->p >= t->end || *t->p != ']') {
    free_segs(segs, count);
    return tp_fail(t, "unterminated table header");
  }
  t->p++;
  if(array_table) {
    if(t->p >= t->end || *t->p != ']') {
      free_segs(segs, count);
      return tp_fail(t, "unterminated array-of-tables header");
    }
    t->p++;
  }
  ap_tval_t *table = root;
  for(size_t i = 0; i + 1 < count; i++) {
    table = descend(t, table, segs[i]);
    if(!table) {
      free_segs(segs, count);
      return -1;
    }
  }
  const char *last = segs[count - 1];
  ap_tval_t *v = table_get_mut(table, last);
  if(array_table) {
    if(!v) {
      v = tv_new(AP_TV_ARRAY);
      if(!v || table_put(table, last, v) != 0) {
        ap_toml_free(v);
        free_segs(segs, count);
        return tp_fail(t, "out of memory");
      }
      v->table_array = 1;
    } else if(v->type != AP_TV_ARRAY || !v->table_array) {
      free_segs(segs, count);
      return tp_fail(t, "key '%s' is not an array of tables", last);
    }
    ap_tval_t *elem = tv_new(AP_TV_TABLE);
    if(!elem || array_push(v, elem) != 0) {
      ap_toml_free(elem);
      free_segs(segs, count);
      return tp_fail(t, "out of memory");
    }
    elem->defined = 1;
    *current = elem;
  } else {
    if(!v) {
      v = tv_new(AP_TV_TABLE);
      if(!v || table_put(table, last, v) != 0) {
        ap_toml_free(v);
        free_segs(segs, count);
        return tp_fail(t, "out of memory");
      }
    } else if(v->type != AP_TV_TABLE) {
      free_segs(segs, count);
      return tp_fail(t, "key '%s' is not a table", last);
    } else if(v->defined) {
      free_segs(segs, count);
      return tp_fail(t, "table '%s' defined twice", last);
    }
    v->defined = 1;
    *current = v;
  }
  free_segs(segs, count);
  return expect_eol(t);
}

static int
parse_keyval(tp_t *t, ap_tval_t *current) {
  char **segs = NULL;
  size_t count = 0;
  if(parse_key_path(t, &segs, &count) != 0) return -1;
  skip_ws(t);
  if(t->p >= t->end || *t->p != '=') {
    free_segs(segs, count);
    return tp_fail(t, "expected '='");
  }
  t->p++;
  ap_tval_t *table = current;
  for(size_t i = 0; i + 1 < count; i++) {
    table = descend(t, table, segs[i]);
    if(!table) {
      free_segs(segs, count);
      return -1;
    }
  }
  const char *last = segs[count - 1];
  if(table_get_mut(table, last)) {
    int rc = tp_fail(t, "duplicate key '%s'", last);
    free_segs(segs, count);
    return rc;
  }
  ap_tval_t *v = parse_value(t);
  if(!v) {
    free_segs(segs, count);
    return -1;
  }
  if(table_put(table, last, v) != 0) {
    ap_toml_free(v);
    free_segs(segs, count);
    return tp_fail(t, "out of memory");
  }
  free_segs(segs, count);
  return expect_eol(t);
}

ap_tval_t *
ap_toml_parse(const char *text, size_t len, char *err, size_t err_size) {
  tp_t t = { text, text + len, 1, err, err_size };
  ap_tval_t *root = tv_new(AP_TV_TABLE);
  ap_tval_t *current = root;
  if(!root) {
    tp_fail(&t, "out of memory");
    return NULL;
  }
  /* UTF-8 byte order mark. */
  if(len >= 3 && (unsigned char)text[0] == 0xEF &&
     (unsigned char)text[1] == 0xBB && (unsigned char)text[2] == 0xBF) {
    t.p += 3;
  }
  for(;;) {
    skip_ws_nl(&t);
    if(t.p >= t.end) break;
    int rc = *t.p == '[' ? parse_header(&t, root, &current)
                         : parse_keyval(&t, current);
    if(rc != 0) {
      ap_toml_free(root);
      return NULL;
    }
  }
  return root;
}

ap_tval_t *
ap_toml_parse_file(const char *path, char *err, size_t err_size) {
  struct stat st;
  int fd = open(path, O_RDONLY);
  if(fd < 0) {
    if(err && err_size) {
      snprintf(err, err_size, "open profile: %s", strerror(errno));
    }
    return NULL;
  }
  if(fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) ||
     st.st_size > (off_t)AP_TOML_MAX_FILE) {
    if(err && err_size) snprintf(err, err_size, "%s", "bad profile file");
    close(fd);
    errno = EINVAL;
    return NULL;
  }
  size_t size = (size_t)st.st_size;
  char *buf = malloc(size + 1);
  if(!buf) {
    close(fd);
    if(err && err_size) snprintf(err, err_size, "%s", "out of memory");
    return NULL;
  }
  size_t done = 0;
  while(done < size) {
    ssize_t n = read(fd, buf + done, size - done);
    if(n < 0 && errno == EINTR) continue;
    if(n <= 0) break;
    done += (size_t)n;
  }
  close(fd);
  if(done != size) {
    free(buf);
    if(err && err_size) snprintf(err, err_size, "%s", "short profile read");
    errno = EIO;
    return NULL;
  }
  buf[size] = 0;
  ap_tval_t *root = ap_toml_parse(buf, size, err, err_size);
  free(buf);
  return root;
}
