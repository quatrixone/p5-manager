FROM python:3.11-slim-bookworm

WORKDIR /app

# System deps: dumb-init for clean signal handling, libssl/libffi for pyremoteplay's
# crypto stack, and a couple of audio/video runtime libs so pyremoteplay can be
# imported even though we run input-only sessions.
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init curl ca-certificates \
      libssl3 libffi8 libcrypt1 \
      ffmpeg \
      gcc python3-dev libssl-dev libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Python sidecar (pair + register + input over HTTP).
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
 && apt-get purge -y --auto-remove gcc python3-dev libssl-dev libffi-dev \
 && rm -rf /var/lib/apt/lists/*

COPY server.py /app/server.py
COPY pyremoteplay_patches.py /app/pyremoteplay_patches.py

ENV CHIAKI_SIDECAR_HOST=0.0.0.0 \
    CHIAKI_SIDECAR_PORT=9555

EXPOSE 9555

ENTRYPOINT ["dumb-init", "--"]
CMD ["python", "/app/server.py"]
