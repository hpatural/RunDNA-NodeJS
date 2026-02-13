# RunDNA Node.js API (Auth + Strava Ingestion + Analysis)

## Stack
- Node.js 20+
- Fastify
- JWT access/refresh tokens
- PostgreSQL (required, auto schema init at startup)
- Strava OAuth + webhook + background sync jobs

## Endpoints
- `GET /` (landing page)
- `GET /health`
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `POST /v1/auth/logout` (Bearer token required)
- `GET /v1/me` (Bearer token required)
- `GET /v1/providers/available`
- `GET /v1/providers/connections` (Bearer token required)
- `POST /v1/providers/connect` (Bearer token required)
- `GET /v1/providers/strava/oauth/start` (Bearer token required)
- `GET /v1/providers/strava/oauth/callback` (Strava redirect endpoint)
- `POST /v1/providers/strava/oauth/exchange` (Bearer token required, mobile flow)
- `GET /v1/providers/strava/status` (Bearer token required)
- `POST /v1/providers/strava/sync` (Bearer token required)
- `GET /v1/analysis/strava?days=30` (Bearer token required)
- `GET /v1/providers/strava/webhook` (Strava challenge endpoint)
- `POST /v1/providers/strava/webhook` (Strava events endpoint)

## Quick start
```bash
cp .env.example .env
npm install
npm run dev
```

## Required env vars
Base:
- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`

Strava:
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REDIRECT_URI`
- `STRAVA_WEBHOOK_VERIFY_TOKEN`

Optional Strava tuning:
- `STRAVA_SCOPE` (default: `read,activity:read_all`)
- `STRAVA_TOKEN_REFRESH_BUFFER_SECONDS` (default: `900`)
- `STRAVA_TOKEN_REFRESH_INTERVAL_MINUTES` (default: `10`)
- `STRAVA_SYNC_INTERVAL_MINUTES` (default: `30`)
- `STRAVA_SYNC_MAX_PAGES` (default: `10`)

## Strava flow
1. App calls `GET /v1/providers/strava/oauth/start` with bearer token.
2. Backend returns `authorizationUrl` and signed `state`.
3. User authorizes Strava.
4. Exchange code:
Either
- Web callback: Strava redirects to `/v1/providers/strava/oauth/callback`.
Or
- Mobile callback: app calls `POST /v1/providers/strava/oauth/exchange` with `{ "code": "..." }`.
5. Trigger sync with `POST /v1/providers/strava/sync`.
6. Read insights via `GET /v1/analysis/strava?days=30`.

## Analysis output
`GET /v1/analysis/strava` returns:
- summary (distance, D+, moving time, pace, HR)
- load (acute/chronic load, fatigue, readiness, monotony)
- trends (7d pace trend vs previous 7d)
- insights (actionable coaching hints)

## Render notes
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Env vars:
  - `DATABASE_URL` from Render PostgreSQL
  - `DATABASE_SSL=true` if SSL is required by your DB endpoint
  - `CORS_ORIGIN` set one or many origins separated by commas (`*` for all)
  - `JWT_ACCESS_SECRET` strong value
  - `JWT_REFRESH_SECRET` strong value
