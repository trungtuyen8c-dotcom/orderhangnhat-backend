FROM node:22-slim

# Prisma cần openssl
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

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
