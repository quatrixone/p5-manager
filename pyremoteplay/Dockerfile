FROM python:3.11-slim-bookworm

WORKDIR /app

# System deps:
#   - dumb-init: clean signal handling for the Python sidecar process,
#   - libssl3/libffi8/libcrypt1: runtime libs for pyremoteplay's crypto stack,
#   - ffmpeg + libav*: PyAV bundles its own ffmpeg in the binary wheel, but
#     when pip falls back to building from source (e.g. wheel mismatch) we
#     need the dev headers + pkg-config available. They are purged below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init curl ca-certificates \
      libssl3 libffi8 libcrypt1 \
      ffmpeg \
      gcc python3-dev libssl-dev libffi-dev \
      pkg-config \
      libavcodec-dev libavformat-dev libavutil-dev \
      libswscale-dev libswresample-dev libavdevice-dev libavfilter-dev \
    && rm -rf /var/lib/apt/lists/*

# Python sidecar (pair + register + input over HTTP).
COPY requirements.txt /app/requirements.txt
# Upgrade pip first so its wheel resolver picks newer manylinux tags (PyAV
# wheels target manylinux_2_17 which older pip versions sometimes reject in
# favour of the source tarball).
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /app/requirements.txt \
 && apt-get purge -y --auto-remove \
      gcc python3-dev libssl-dev libffi-dev \
      pkg-config \
      libavcodec-dev libavformat-dev libavutil-dev \
      libswscale-dev libswresample-dev libavdevice-dev libavfilter-dev \
 && rm -rf /var/lib/apt/lists/*

COPY server.py /app/server.py
COPY pyremoteplay_patches.py /app/pyremoteplay_patches.py

ENV PYREMOTEPLAY_SIDECAR_HOST=0.0.0.0 \
    PYREMOTEPLAY_SIDECAR_PORT=9555

EXPOSE 9555

ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "/app/server.py"]
