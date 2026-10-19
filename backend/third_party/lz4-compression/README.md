# Host AMPR packer component

This folder contains the host CLI wrapper and upstream AMPR packer sources
used by P5 Manager's `Folder → LZ4` conversion. The upstream project is
`theghostonline/PS5-LZ4-Compression`; the vendored version and license are
recorded in `UPSTREAM_NOTICES.md` and `LICENSE`. This component is distributed
under GPL-3.0-or-later, separately from the MIT-licensed P5 Manager code.

Build with `sh build.sh /path/to/lz4-pack-cli` on Linux with a C compiler,
Python 3 and zlib development headers.
