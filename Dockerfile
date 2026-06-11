FROM node:20-bullseye AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Bookworm (Debian 12) ships Python 3.11 - required by mkpfs >= some
# release that started using `from enum import StrEnum` (Py 3.11+).
# Bullseye (Py 3.9) crashed at import time with "cannot import name
# 'StrEnum' from 'enum'".
FROM debian:bookworm-slim

WORKDIR /app

# mkpfs version pin. Default `latest` resolves to whatever PyPI ships at
# build time (currently 0.0.7). Override at build to lock to a specific
# release, e.g.:
#   docker compose build --build-arg MKPFS_VERSION=0.0.7 app
#
# We also enforce a minimum floor (>=0.0.7) so a stale Docker layer cache
# can't silently keep 0.0.6 around even when the user *intended* `latest`.
# 0.0.7 is required for our --inode-bits + PS5 default behaviour in
# backend/src/routes/convert.js; see release notes:
#   https://github.com/PSBrew/MkPFS/releases/tag/0.0.7
ARG MKPFS_VERSION=latest
ARG MKPFS_MIN_VERSION=0.0.7

# mkpfs is installed into a per-app venv (instead of the system site-
# packages) so the runtime user (1000:1000, see docker-compose.yml) owns
# the install directory and can do live upgrades via the UI's "Update
# mkpfs" button. No docker socket exposure, no root-in-container.
ENV MKPFS_VENV=/app/.venv \
    MKPFS_BIN=/app/.venv/bin/mkpfs \
    MKPFS_PIP=/app/.venv/bin/pip \
    PKG_TOOL_VENV=/app/.venv-pkg \
    PKG_TOOL_BIN=/app/.venv-pkg/bin/unpkg \
    PKG_TOOL_PIP=/app/.venv-pkg/bin/pip \
    PATH=/app/.venv/bin:/app/.venv-pkg/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init python3 python3-pip python3-venv curl smbclient ftp rsync coreutils \
    p7zip-full unrar-free unar \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv "$MKPFS_VENV" \
    && "$MKPFS_PIP" install --no-cache-dir --upgrade pip \
    && if [ "$MKPFS_VERSION" = "latest" ]; then \
         PIP_SPEC="mkpfs>=${MKPFS_MIN_VERSION}"; \
       else \
         PIP_SPEC="mkpfs==${MKPFS_VERSION}"; \
       fi \
    && "$MKPFS_PIP" install --no-cache-dir --upgrade "$PIP_SPEC" \
    && installed="$("$MKPFS_BIN" -V 2>&1 || true)" \
    && echo "Installed mkpfs: $installed" \
    && "$MKPFS_VENV/bin/python" -c "import importlib.metadata as m, sys, re; \
v=m.version('mkpfs'); print('verified mkpfs', v); \
parts=lambda s: tuple(int(x) for x in re.findall(r'\d+', s)); \
sys.exit(0 if parts(v) >= parts('${MKPFS_MIN_VERSION}') else 1)" \
    && chown -R 1000:1000 "$MKPFS_VENV"

# PS4 PKG tooling lives in its own venv so it can be upgraded/replaced
# from the UI without disturbing the mkpfs install. We bundle a Python 3
# port of flatz's unpkg.py directly in the repo at backend/src/lib/unpkg.py
# (see that file for credits + format docs) so the build is hermetic —
# no network dependency, no relying on flaky third-party raw github URLs.
#
# The wrapper at /app/.venv-pkg/bin/unpkg exposes a pip-style CLI so the
# rest of the system can treat it the same as mkpfs (status check,
# upgrade endpoint, version string).
#
# Pack (folder → PKG) requires Sony's orbis-pub-cmd which is Windows-
# only; we deliberately ship unpack-only for now and the /pkg/pack
# endpoint returns a clear "tool not available" error.
ARG PKG_TOOL_VERSION=2026-06-09
RUN python3 -m venv "$PKG_TOOL_VENV" \
    && "$PKG_TOOL_PIP" install --no-cache-dir --upgrade pip \
    && printf '#!/bin/sh\nset -e\nSELF_DIR="$(dirname "$0")"\nVENV_PY="$SELF_DIR/python"\nUNPKG_PY="$SELF_DIR/unpkg.py"\nif [ "$1" = "--version" ] || [ "$1" = "-V" ]; then\n  if [ -f "$SELF_DIR/VERSION" ]; then cat "$SELF_DIR/VERSION"; else echo "unknown"; fi\n  exit 0\nfi\nif [ ! -f "$UNPKG_PY" ]; then\n  echo "PS4 PKG tool not installed. Run pkg-upgrade from the UI." >&2\n  exit 127\nfi\nexec "$VENV_PY" "$UNPKG_PY" "$@"\n' > "$PKG_TOOL_BIN" \
    && chmod +x "$PKG_TOOL_BIN" \
    && echo "${PKG_TOOL_VERSION}" > "$PKG_TOOL_VENV/bin/VERSION" \
    && chown -R 1000:1000 "$PKG_TOOL_VENV"

# Copy the vendored unpkg.py into the PKG venv. Separate from the venv
# scaffolding RUN above so changing the script doesn't invalidate the
# pip-install layer cache. Re-runs cheaply on edits.
COPY backend/src/lib/unpkg.py /app/.venv-pkg/bin/unpkg.py
RUN chmod 0644 /app/.venv-pkg/bin/unpkg.py && chown 1000:1000 /app/.venv-pkg/bin/unpkg.py

COPY backend/package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY backend/ ./
# Vite outputs to ../backend/dist in the frontend-builder stage,
# i.e. /app/backend/dist. Copy that into /app/dist so the production
# server can serve `__dirname/../dist` (matches local dev layout).
COPY --from=frontend-builder /app/backend/dist ./dist

# /frontend/builtin/ holds the user-editable lists of built-in payloads,
# autoload templates and input scripts. Both the frontend (bundled by
# Vite) and the backend import these files at runtime; copy them so the
# backend loader (src/lib/builtinLoader.js) can resolve ../../builtin
# from /app/src/lib/.
COPY frontend/builtin/ ./builtin/

RUN mkdir -p /app/data/payloads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]