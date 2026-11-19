ampr-emu-ng runtime (fakelib/libSceAmpr.sprx), for zstd asset packs.

SHA-256: 9c7c41b3216bc4f877d67e3c2e5c9c8f9ffabdd5065f4f3fe0dd98fa7228386f
Size: 733,104 bytes

Copied unchanged from ps5-dump-forge, where it is the pinned runtime
installed into every zstd-packed game:
https://github.com/quer3q/ps5-dump-forge/blob/main/vendor/ampr-emu-ng/libSceAmpr.sprx

The PackedStdio build in ../ampr_emu reads the LZ4 packs (AMPRPAK4/AMPRDAT3)
and cannot read these (AMPRZPK1/AMPRZDT1); this one reads both. A game packed
with zstd must therefore get this runtime, and must not have the LZ4 one put
back over it.

ampr-emu-ng is licensed under the GNU GPL v3, as drakmor's ampr_emu it
derives from. Source: https://github.com/drakmor/ampr_emu
