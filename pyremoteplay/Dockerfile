# Remote Play service: the Python HTTP service plus p5rp, the session helper
# on libchiaki (../rpnative, passed in as the build context "rpnative" - see
# docker-compose.yml and .github/workflows/docker-image.yml).

# ── p5rp ─────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS p5rp
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git cmake ninja-build gcc g++ pkg-config \
      libjson-c-dev libminiupnpc-dev libevent-dev libssl-dev \
      python3 python3-protobuf protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rpnative . /src/rpnative
RUN cmake -S /src/rpnative -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release \
 && cmake --build /build --target p5rp \
 && strip /build/p5rp

# ── the service ──────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm

WORKDIR /app

# dumb-init for clean signals; what p5rp links against (libchiaki itself is
# built into it).
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init curl ca-certificates \
      libjson-c5 libminiupnpc17 libevent-2.1-7 libssl3 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
# PyAV's wheel brings its own ffmpeg; a newer pip picks the manylinux wheel
# rather than the source tarball.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /app/requirements.txt

COPY --from=p5rp /build/p5rp /usr/local/bin/p5rp
COPY --from=rpnative LICENSE /usr/local/share/p5rp/LICENSE
COPY server.py chiaki_engine.py ddp.py psn_oauth.py /app/

ENV PYREMOTEPLAY_SIDECAR_HOST=0.0.0.0 \
    PYREMOTEPLAY_SIDECAR_PORT=9555 \
    P5RP_BIN=/usr/local/bin/p5rp

EXPOSE 9555

ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "/app/server.py"]
