# RunDNA Node.js API (MVP Auth)

## Stack
- Node.js 20+
- Fastify
- JWT access/refresh tokens
- PostgreSQL (auto schema init if `DATABASE_URL` is set)
- In-memory fallback when `DATABASE_URL` is empty

## Endpoints
- `GET /` (landing page with app download placeholder + fake QR)
- `GET /health`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout` (Bearer token required)
- `GET /v1/me` (Bearer token required)

## Quick start
```bash
cp .env.example .env
npm install
npm run dev
```

## Example payloads
Register:
```json
{
  "email": "runner@example.com",
  "password": "password123"
}
```

Login:
```json
{
  "email": "runner@example.com",
  "password": "password123"
}
```

Refresh:
```json
{
  "refreshToken": "<token>"
}
```

## Render notes
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Env vars:
  - `DATABASE_URL` from Render PostgreSQL
  - `DATABASE_SSL=true` if SSL is required by your DB endpoint
  - `JWT_ACCESS_SECRET` strong value
  - `JWT_REFRESH_SECRET` strong value

## Next backend steps
1. Add OAuth provider tables (Strava, Apple, Google).
2. Expose `/v1/providers`, `/v1/dashboard`, `/v1/activities` with DB-backed data.
3. Add migrations tooling (Prisma/Knex/Drizzle) for versioned schema changes.
