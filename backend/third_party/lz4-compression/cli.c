/* GPL-3.0-or-later. Small host CLI around the upstream AMPR packer API. */
#include "src/ampr_pack.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void phase(void *ctx, const char *id, const char *label) {
  (void)ctx;
  printf("{\"type\":\"phase\",\"phase\":\"%s\",\"label\":\"%s\"}\n", id, label);
  fflush(stdout);
}
static void progress(void *ctx, uint64_t done, uint64_t total) {
  (void)ctx;
  printf("{\"type\":\"progress\",\"done\":%llu,\"total\":%llu}\n",
         (unsigned long long)done, (unsigned long long)total);
  fflush(stdout);
}
static void current(void *ctx, const char *rel) { (void)ctx; (void)rel; }
static int cancelled(void *ctx) { (void)ctx; return 0; }
static void log_line(void *ctx, const char *msg) {
  (void)ctx;
  printf("{\"type\":\"log\",\"message\":\"%s\"}\n", msg);
  fflush(stdout);
}

int main(int argc, char **argv) {
  if (argc != 5 || strcmp(argv[1], "pack") != 0) {
    fprintf(stderr, "usage: lz4-pack-cli pack SOURCE_DIR OUTPUT_DIR LEVEL(1-12)\n");
    return 2;
  }
  int level = atoi(argv[4]);
  if (level < 1 || level > 12) {
    fprintf(stderr, "LZ4 level must be between 1 and 12\n");
    return 2;
  }
  ampr_pack_options_t opts;
  memset(&opts, 0, sizeof(opts));
  opts.source_root = argv[2];
  opts.output_root = argv[3];
  opts.mode = AMPR_PACK_MODE_COPY;
  opts.level = level;
  opts.block_shift = 16;
  opts.auto_loose_large = 1;
  opts.runtime = ampr_pack_runtime_data(&opts.runtime_size);
  opts.install_runtime_if_missing = 1;
  opts.verify_loose_copies = 1;
  opts.cb.phase = phase;
  opts.cb.progress = progress;
  opts.cb.current = current;
  opts.cb.cancelled = cancelled;
  opts.cb.log = log_line;
  ampr_pack_stats_t stats;
  char err[1024] = {0};
  if (ampr_pack_build(&opts, &stats, err, sizeof(err)) != 0) {
    fprintf(stderr, "%s\n", err[0] ? err : "LZ4 pack failed");
    return 1;
  }
  fprintf(stdout, "{\"type\":\"complete\",\"files\":%llu,\"packed\":%llu,\"bytes\":%llu}\n",
          (unsigned long long)stats.files_total,
          (unsigned long long)stats.files_packed,
          (unsigned long long)stats.pack_bytes);
  return 0;
}
