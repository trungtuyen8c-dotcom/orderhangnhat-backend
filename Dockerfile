# syntax=docker/dockerfile:1

# ---------- deps: full deps (dev included) de build ----------
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ---------- build: tsc + prisma generate ----------
FROM deps AS build
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- prod-deps: chi dependencies (khong dev) ----------
FROM node:22-slim AS prod-deps
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------- tools: prisma CLI (migrate deploy) + tsx (seed/backfill chay tay) ----------
# 2 goi nay nam trong devDependencies -> cai rieng vao /opt/tools dung version trong lockfile (khong doi package.json)
FROM prod-deps AS tools
RUN PRISMA_V=$(node -p "require('./package-lock.json').packages['node_modules/prisma'].version") \
 && TSX_V=$(node -p "require('./package-lock.json').packages['node_modules/tsx'].version") \
 && mkdir -p /opt/tools && cd /opt/tools && echo '{"private":true}' > package.json \
 && npm install --no-audit --no-fund "prisma@${PRISMA_V}" "tsx@${TSX_V}" \
 && npm cache clean --force

# ---------- runtime ----------
FROM node:22-slim AS runtime

# Prisma can openssl; backup can pg_dump 16 (repo PGDG) + rclone + tar/gzip
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates rclone tar gzip curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
 && update-ca-certificates && rm -rf /var/lib/apt/lists/*

# User non-root UID/GID co dinh 10001 (volume rclone tren VPS can chown 10001:10001 1 lan)
RUN groupadd -g 10001 app \
 && useradd -u 10001 -g app -m -d /home/app -s /usr/sbin/nologin app \
 && mkdir -p /home/app/.config/rclone /tmp/backups \
 && chown -R app:app /home/app /tmp/backups

ENV NODE_ENV=production \
    PORT=4000 \
    HOME=/home/app \
    RCLONE_CONFIG=/home/app/.config/rclone/rclone.conf \
    PATH=/opt/tools/node_modules/.bin:$PATH

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=tools /opt/tools /opt/tools
# Client da generate o stage build (ghi de stub cua @prisma/client khi cai --ignore-scripts)
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
COPY prisma ./prisma

USER app
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start: apply migration (khong db push, khong seed) roi chay server.
# prisma goi thang tu /opt/tools (tren PATH) - npx se bo qua PATH va tai ban moi tu registry.
# Seed chay tay: docker compose exec backend npm run db:seed
CMD ["sh", "-c", "prisma migrate deploy && exec node dist/index.js"]
