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
  jwtAccessSecret: requireEnv('JWT_ACCESS_SECRET', 'change_me_access_secret'),
  jwtRefreshSecret: requireEnv('JWT_REFRESH_SECRET', 'change_me_refresh_secret'),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d'
};

module.exports = { env };
