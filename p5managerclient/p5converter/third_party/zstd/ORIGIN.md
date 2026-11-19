zstd 1.5.7 (facebook/zstd), lib/ subset: common/, compress/, decompress/,
zstd.h and zstd_errors.h. Copied unchanged from the release tarball
zstd-1.5.7.tar.gz, whose published SHA-256 was checked before unpacking.

Left out: legacy/, deprecated/, dictBuilder/, dll/ (unused here) and
decompress/*.S (the x86-64 Huffman assembly; the build sets
ZSTD_DISABLE_ASM and uses the C path, so the payload needs no assembler).

zstd is dual licensed BSD-3-Clause and GPL-2.0; the BSD-3-Clause terms
(lib/../LICENSE in the tarball) are compatible with this payload's
GPL-3.0-or-later.
