ampr_emu 0.4.2.1 PackedStdio runtime (fakelib/libSceAmpr.sprx)

SHA-256: 69e6c4d5e4f5fb83c9e01815db5861c4c75734acbf4595cafa50d4c218116d1a

Copied unchanged from Lazy_AMPR, where it is the pinned runtime installed into
every LZ4-packed game:
https://github.com/Nazky/Lazy_AMPR/blob/main/resources/fakelib/libSceAmpr.sprx

This is drakmor's ampr_emu (APR emulator) built with the
`Prospero_ReleaseHooksPackedStdio` configuration, which adds the seekable LZ4
asset-pack reader (AMPRPAK4/AMPRDAT3). The `LooseStdio` builds on the public
APR-EMU mirror cannot read asset packs, so LZ4-packed games must keep this
runtime.

ampr_emu is licensed under the GNU GPL v3. Source code:
https://github.com/drakmor/ampr_emu
