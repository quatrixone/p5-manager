FROM node:20-bullseye AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM debian:bullseye-slim

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
    PATH=/app/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

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