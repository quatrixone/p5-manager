#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-"$ROOT/lz4-pack-cli"}
GEN="$ROOT/runtime_blob.c"
python3 "$ROOT/gen_binary_c.py" --symbol lzc_ampr_runtime_blob \
  --sha256 69e6c4d5e4f5fb83c9e01815db5861c4c75734acbf4595cafa50d4c218116d1a \
  "$ROOT/runtime/libSceAmpr.sprx" > "$GEN"
cc -O2 -std=c11 -D_GNU_SOURCE -pthread \
  -I"$ROOT/src" -I"$ROOT/lz4" \
  "$ROOT/cli.c" "$ROOT/src/ampr_index.c" "$ROOT/src/ampr_pack.c" \
  "$ROOT/src/ampr_pack_profile.c" "$ROOT/src/ampr_pack_toml.c" \
  "$ROOT/src/ampr_pack_runtime.c" "$ROOT/lz4/lz4.c" "$ROOT/lz4/lz4hc.c" \
  "$GEN" -lz -o "$OUT"
