# RunDNA Node.js API (MVP Auth)

## Stack
- Node.js 20+
- Fastify
- JWT access/refresh tokens
- In-memory user store (to be replaced by DB)

## Endpoints
- `GET /health`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout` (Bearer token required)
- `GET /v1/me` (Bearer token required)

## Quick start
```bash
cd nodejs
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
- Env vars: copy from `.env.example` (use strong JWT secrets in production)

## Next backend steps
1. Replace in-memory repository by PostgreSQL.
2. Add persistent refresh-token table.
3. Add OAuth provider tables (Strava, Apple, Google).
4. Expose `/v1/providers`, `/v1/dashboard`, `/v1/activities` with DB-backed data.
