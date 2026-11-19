#!/bin/sh
# Builds and runs the host-side unpacker for AMPR zstd pack sets.
set -e
cd "$(dirname "$0")/.."
BIN="${TMPDIR:-/tmp}/lzc-zstd-unpack"
ZSTD_SRC=$(find third_party/zstd/common third_party/zstd/decompress -name '*.c')
[ -x "$BIN" ] || ${CC:-cc} -O2 -Wall -DZSTD_DISABLE_ASM=1 -DZSTD_MULTITHREAD=0 \
  -Ithird_party/zstd -Ithird_party/zstd/common -Isrc \
  tools/zstd_unpack.c $ZSTD_SRC -lz -o "$BIN"
exec "$BIN" "$@"
