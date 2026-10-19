/*
 * LZ4 Compression - background folder-size estimate cache.
 */

#pragma once

#include <stdint.h>
#include <time.h>

typedef enum lzc_size_status {
  LZC_SIZE_STATUS_UNKNOWN = 0,
  LZC_SIZE_STATUS_CACHED,
  LZC_SIZE_STATUS_QUEUED,
  LZC_SIZE_STATUS_SCANNING,
  LZC_SIZE_STATUS_REFRESHING,
  LZC_SIZE_STATUS_DONE,
  LZC_SIZE_STATUS_FAILED,
} lzc_size_status_t;

const char *lzc_size_status_name(lzc_size_status_t status);
int lzc_size_cache_lookup(const char *path, uint64_t *size_out,
                         time_t *measured_at_out,
                         lzc_size_status_t *status_out);
void lzc_size_cache_store(const char *path, uint64_t size);
void lzc_size_cache_forget(const char *path);
void lzc_size_cache_queue_measure(const char *path);
void lzc_size_cache_queue_recheck(const char *path);
lzc_size_status_t lzc_size_cache_priority(const char *path);
