PS5 Dump Forge 0.5.6, the console payload (`ps5-dump-forge-0.5.6-ps5.elf`).

SHA-256: f0415aab6ded1cdf875418b6683ab56aeae3721492af99fba71b08c2c351f82f
Size: 18,549,840 bytes

Taken unchanged from the project's own release, whose published SHA256SUMS
was checked before it was copied here:
https://github.com/quer3q/ps5-dump-forge/releases/tag/v0.5.6

It serves a REST API on TCP 8095 and converts a game on the console between
a folder, `.exfat`, `.ffpkg`, `.ffpfs`, `.ffpfsc`, `.pkg` and LZ4 or zstd
asset packs, reads `.zip`/`.7z`/`.rar` sources without unpacking them, and
verifies every job against the source. It installs the AMPR runtime a packed
title needs (ampr-emu-ng for zstd) itself, and does not need
ShadowMountPlus to read the drives.

PS5 Dump Forge is licensed under the GNU GPL v3 or later. Source code:
https://github.com/quer3q/ps5-dump-forge
