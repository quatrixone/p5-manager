FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY backend/package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY backend/ ./

COPY --from=frontend-builder /app/frontend/dist ./dist

RUN mkdir -p /app/data/payloads

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]