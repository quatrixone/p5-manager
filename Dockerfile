FROM node:20-bullseye AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM debian:bullseye-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init python3 python3-pip curl smbclient ftp rsync coreutils \
    p7zip-full unrar-free unar \
    && rm -rf /var/lib/apt/lists/* \
    && curl -sL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && (pip3 install --break-system-packages --no-cache-dir mkpfs || pip3 install --no-cache-dir mkpfs)

COPY backend/package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY backend/ ./
# Vite outputs to ../backend/dist in the frontend-builder stage,
# i.e. /app/backend/dist. Copy that into /app/dist so the production
# server can serve `__dirname/../dist` (matches local dev layout).
COPY --from=frontend-builder /app/backend/dist ./dist

RUN mkdir -p /app/data/payloads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]