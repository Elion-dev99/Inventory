# syntax=docker/dockerfile:1
# 在庫管理システム 本番用イメージ
# 運用構成: Cloudflare Containers (linux/amd64 が必須) + 外部マネージド PostgreSQL (Neon) / Redis (Upstash)
# デプロイ手順は cloudflare/README.md を参照。

# ---------- build stage ----------
FROM --platform=linux/amd64 node:22-bookworm-slim AS build
WORKDIR /app

# Prisma のエンジン取得/生成に必要 (OpenSSL の検出と TLS 検証)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---------- runtime stage ----------
FROM --platform=linux/amd64 node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Prisma クエリエンジンが実行時に libssl を動的リンクするため runtime 側にも必要
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 生成済み Prisma Client を含むため node_modules は build stage からそのままコピーする
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --chown=node:node package.json ./

# 非 root (node イメージ標準ユーザー) で実行
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
