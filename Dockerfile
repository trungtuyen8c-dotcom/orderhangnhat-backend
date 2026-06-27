FROM node:22-slim

# Prisma cần openssl; backup cần pg_dump 16 (repo PGDG) + rclone + tar/gzip
RUN apt-get update && apt-get install -y openssl ca-certificates rclone tar gzip curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y postgresql-client-16 \
 && update-ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV PORT=4000
EXPOSE 4000

# Khi container start: đồng bộ schema + seed + chạy server
CMD ["sh", "-c", "npm run db:deploy && npm start"]
