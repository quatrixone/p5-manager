/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 theghostonline. Based on drakmor's ampr_pack.py (GPL-3.0).
 *
 * LZ4 Compression - pinned ampr_emu PackedStdio runtime for LZ4 packs.
 */

#include "ampr_pack.h"

extern const unsigned char lzc_ampr_runtime_blob[];
extern const size_t lzc_ampr_runtime_blob_size;
extern const char lzc_ampr_runtime_blob_sha256[];

const unsigned char *
ampr_pack_runtime_data(size_t *size) {
  if(size) *size = lzc_ampr_runtime_blob_size;
  return lzc_ampr_runtime_blob;
}

const char *
ampr_pack_runtime_sha256(void) {
  return lzc_ampr_runtime_blob_sha256;
}

const char *
ampr_pack_runtime_version(void) {
  return "0.4.2.1 PackedStdio";
}
