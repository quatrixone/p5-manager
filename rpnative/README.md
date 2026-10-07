# p5rp - Remote Play session helper

A small program that holds one Remote Play session with a PS4 or PS5 and
hands the video on as the console encoded it. It is built on
[libchiaki](https://github.com/streetpea/chiaki-ng) (chiaki-ng), which does
the protocol work: session setup, the Takion transport, encryption, forward
error correction, congestion control.

P5 Manager's Remote Play service starts one `p5rp` per session and talks to
it through its standard streams; nothing else is meant to run it.

## Licence

`p5rp` links libchiaki and is therefore under the **GNU Affero General
Public License, version 3** (see [LICENSE](LICENSE)) - unlike the rest of
P5 Manager, which is MIT and only starts this program as a separate process.
Its source is this directory; the libchiaki source it is built from is the
chiaki-ng tag named in `CMakeLists.txt`.

## Build

    cmake -S rpnative -B build-rp -G Ninja -DCMAKE_BUILD_TYPE=Release
    cmake --build build-rp --target p5rp

Needs a C compiler, CMake 3.20+, pkg-config, json-c, miniupnpc, libevent,
OpenSSL, and a Python 3 with the `protobuf` module. On Windows this is done
in an MSYS2 MinGW64 shell; the DLLs `ldd` lists from `mingw64` go next to
the exe.

## Interface

    p5rp --host <ip> [--ps4] [--res 360|540|720|1080] [--fps 30|60]
         [--bitrate <kbit/s>] [--codec h264|h265]

The pairing keys come in the environment (`P5RP_REGIST_KEY`,
`P5RP_MORNING` as 32 hex characters), not on the command line.

- **stdout** - the video in Annex B, one record per frame: `'V'`, a flags
  byte (1 key frame, 2 frames were lost before it, 4 repaired by FEC), the
  length (4 bytes, big endian), a time stamp in microseconds (8 bytes, big
  endian), the data.
- **stderr** - one JSON object per line: `starting`, `connected`, `stats`
  (every 5 s), `log`, `fec_failure`, `quit` (with the reason).
- **stdin** - one command per line: `btn <name> <0|1>`,
  `trigger <l2|r2> <0..255>`, `stick <l|r> <x> <y>`, `idle`, `standby`,
  `stop`. End of input ends the session, so the helper never outlives the
  program that started it.
