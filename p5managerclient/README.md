# p5managerclient

Host-side client-tooling for P5 Manager — everything we need on the
host that builds payloads / talks to the PS5 directly:

- The vendored
  [ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk)
  toolchain (`sdk/`, gitignored — 35 MB binary toolchain).
- Three PS5 payload projects that compile against it:
  - `offact/` — headless offline PSN activation
  - `rp-get-pin/` — Remote Play PIN + Account ID harvester
  - `pkg-install/` — fake-PKG installer for the install queue

## Layout

```
p5managerclient/
├── README.md       (you are here)
├── sdk/            ← ps5-payload-dev SDK, GITIGNORED
│   ├── bin/        ← prospero-clang, prospero-ld, …
│   ├── target/     ← Sce*.sprx stubs + headers
│   ├── toolchain/prospero.mk
│   ├── samples/
│   └── …
├── offact/         ← headless PSN-activation payload (source + Makefile)
├── pkg-install/    ← fake-PKG installer payload (source + Makefile)
└── rp-get-pin/     ← Remote Play PIN harvester payload (source + Makefile)
```

`sdk/` is **not** committed; each developer bootstraps it locally.
The payload Makefiles auto-detect the sibling SDK via:

```make
PS5_PAYLOAD_SDK := $(abspath …/p5managerclient/sdk)
```

so once `sdk/` exists, `cd p5managerclient/offact && make` works
without any exported env vars.

## Bootstrapping the SDK

The SDK ships its own pinned installer that pulls a known-good
toolchain. Run it once from the repo root:

```bash
# Option A: the upstream one-liner
curl -sSL https://raw.githubusercontent.com/ps5-payload-dev/sdk/master/install.sh \
  | env PS5_PAYLOAD_SDK_INSTALL=$(pwd)/p5managerclient/sdk bash

# Option B: clone + make install
git clone https://github.com/ps5-payload-dev/sdk.git /tmp/ps5-payload-sdk-src
cd /tmp/ps5-payload-sdk-src
make install DESTDIR=$(git -C - rev-parse --show-toplevel)/p5managerclient/sdk
```

Either way you should end up with `p5managerclient/sdk/toolchain/prospero.mk`
on disk. To verify:

```bash
cd p5managerclient/offact && make -n
# → /…/p5managerclient/sdk/bin/prospero-clang -O2 -Wl,-s -lSceRegMgr … -o offact.elf …
```

## Falling back to an external SDK

If you already keep the SDK at `/opt/ps5-payload-sdk` (or anywhere
else) you can keep using it — just export the env var before
`make`:

```bash
PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk make -C p5managerclient/offact
```

The Makefiles only auto-detect the in-tree SDK when
`PS5_PAYLOAD_SDK` is *unset*.
