const dotenv = require('dotenv');

dotenv.config();

function requireEnv(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: String(process.env.DATABASE_SSL ?? 'false') === 'true',
  dropDatabaseOnStartup: String(process.env.DROP_DATABASE_ON_STARTUP ?? 'false') === 'true',
  jwtAccessSecret: requireEnv('JWT_ACCESS_SECRET', 'change_me_access_secret'),
  jwtRefreshSecret: requireEnv('JWT_REFRESH_SECRET', 'change_me_refresh_secret'),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
  stravaClientId: process.env.STRAVA_CLIENT_ID ?? '',
  stravaClientSecret: process.env.STRAVA_CLIENT_SECRET ?? '',
  stravaRedirectUri: process.env.STRAVA_REDIRECT_URI ?? '',
  stravaScope: process.env.STRAVA_SCOPE ?? 'read,activity:read_all',
  stravaBaseUrl: process.env.STRAVA_BASE_URL ?? 'https://www.strava.com',
  stravaWebhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? '',
  stravaStateSecret: process.env.STRAVA_STATE_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'change_me_access_secret',
  stravaTokenRefreshBufferSeconds: Number(process.env.STRAVA_TOKEN_REFRESH_BUFFER_SECONDS ?? 900),
  stravaTokenRefreshIntervalMinutes: Number(process.env.STRAVA_TOKEN_REFRESH_INTERVAL_MINUTES ?? 10),
  stravaSyncIntervalMinutes: Number(process.env.STRAVA_SYNC_INTERVAL_MINUTES ?? 30),
  stravaSyncMaxPages: Number(process.env.STRAVA_SYNC_MAX_PAGES ?? 10)
};

module.exports = { env };
