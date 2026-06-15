# orderhangnhat-backend

Node.js + TypeScript + Express + Prisma (PostgreSQL) + Redis.

## Dev
```bash
npm install
cp .env.example .env
npx prisma generate
npm run db:deploy   # db push + seed (cần PG + Redis chạy)
npm run dev
```

## Endpoints
- `GET /api/health`
- `POST /api/auth/login` `{email,password}` -> `{accessToken}` + cookie refresh
- `POST /api/auth/renew` (cookie) -> `{accessToken}`
- `POST /api/auth/logout` / `logout-all` (Bearer)
- `GET /api/me` (Bearer) -> roles + permissions
- `GET/POST /api/orders`, `PATCH /api/orders/:id/status`

Auth: JWT 15p + refresh 7d (httpOnly cookie) + Redis JTI blacklist. RBAC qua `authorize(permission)`.
Super admin seed: `admin@orderhn.local` / `Admin@12345` (đổi qua env).
