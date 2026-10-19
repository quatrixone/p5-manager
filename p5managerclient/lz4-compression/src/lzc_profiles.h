/* LZ4 Compression - ampr_pack TOML profiles bundled with the engine
 * (profiles/index.json, embedded at build time). */
#pragma once

#include <stddef.h>

typedef struct lzc_bundled_profile {
  const char *id;
  const char *file;
  const char *label;
  const char *tested;
  const char *title_ids; /* comma separated */
  const char *names;     /* comma separated, letters and digits only */
  const char *engine;    /* "insomniac", "unity" or "" */
  const unsigned char *data;
  size_t size;
} lzc_bundled_profile_t;

extern const lzc_bundled_profile_t lzc_bundled_profiles[];
extern const size_t lzc_bundled_profile_count;
