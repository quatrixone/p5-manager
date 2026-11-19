#!/bin/sh
# Builds and runs the AMPRZPK1 writer test on the host (not the PS5), against
# the vendored zstd and the system zlib.
set -e
cd "$(dirname "$0")/.."
TMP="${TMPDIR:-/tmp}/lzc-zstd-test"
mkdir -p "$TMP"
ZSTD_SRC=$(find third_party/zstd/common third_party/zstd/compress third_party/zstd/decompress -name '*.c')
${CC:-cc} -O1 -g -fsanitize=address,undefined -Wall -Wextra -Wno-unused-parameter \
  -DZSTD_DISABLE_ASM=1 -DZSTD_MULTITHREAD=0 \
  -Ithird_party/zstd -Ithird_party/zstd/common -Isrc \
  tools/zstd_pack_test.c src/lzc_zstd_pack.c $ZSTD_SRC \
  -lz -o "$TMP/zstd_pack_test"
"$TMP/zstd_pack_test" "$TMP/run"
