# syntax=docker/dockerfile:1
# Продакшн-образ BASE LOUNGE: Telegram-бот + Mini App в одном процессе Node.
# Node 26 исполняет .ts напрямую (type stripping), поэтому сервер не компилируется —
# собирается только фронтенд (Vite → dist/webapp).

# ---------- Сборка Mini App ----------
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN npx vite build

# ---------- Только продакшн-зависимости ----------
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------- Рантайм ----------
FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8000
WORKDIR /app
# Файлы принадлежат root и доступны только на чтение процессу (user node) —
# образ совместим с readOnlyRootFilesystem. Сервер ничего не пишет на диск (аватары —
# в PostgreSQL); для /tmp в Kubernetes монтируется emptyDir.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/webapp ./dist/webapp
# npm/yarn/corepack в рантайме не нужны: убираем из PATH (меньше поверхность атаки).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "src/server/main.ts"]
