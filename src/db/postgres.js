const { Pool } = require('pg');

function createPostgresPool(env) {
  return new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : false
  });
}

async function resetDatabase(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS strava_webhook_events CASCADE;
    DROP TABLE IF EXISTS strava_activities CASCADE;
    DROP TABLE IF EXISTS strava_connections CASCADE;
    DROP TABLE IF EXISTS user_identities CASCADE;
    DROP TABLE IF EXISTS provider_connections CASCADE;
    DROP TABLE IF EXISTS refresh_tokens CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
}

async function ensureAuthSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      refresh_token TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_identities (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      email TEXT,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider),
      UNIQUE (provider, provider_user_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_identities_email
    ON user_identities (email);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strava_connections (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      athlete_id TEXT,
      scope TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expires_at TIMESTAMPTZ NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_synced_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_strava_connections_expires_at
    ON strava_connections (token_expires_at);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_strava_connections_athlete_id
    ON strava_connections (athlete_id)
    WHERE athlete_id IS NOT NULL;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strava_activities (
      activity_id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT,
      sport_type TEXT,
      type TEXT,
      start_date TIMESTAMPTZ NOT NULL,
      timezone TEXT,
      moving_time_sec INTEGER NOT NULL DEFAULT 0,
      elapsed_time_sec INTEGER NOT NULL DEFAULT 0,
      distance_m DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_elevation_gain_m DOUBLE PRECISION NOT NULL DEFAULT 0,
      average_speed_mps DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_speed_mps DOUBLE PRECISION NOT NULL DEFAULT 0,
      average_heartrate DOUBLE PRECISION,
      max_heartrate DOUBLE PRECISION,
      trainer BOOLEAN NOT NULL DEFAULT FALSE,
      commute BOOLEAN NOT NULL DEFAULT FALSE,
      manual BOOLEAN NOT NULL DEFAULT FALSE,
      kudos_count INTEGER NOT NULL DEFAULT 0,
      achievement_count INTEGER NOT NULL DEFAULT 0,
      relative_effort_score DOUBLE PRECISION,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE strava_activities
    ADD COLUMN IF NOT EXISTS relative_effort_score DOUBLE PRECISION;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_strava_activities_user_date
    ON strava_activities (user_id, start_date DESC);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS strava_webhook_events (
      id BIGSERIAL PRIMARY KEY,
      object_type TEXT,
      object_id TEXT,
      aspect_type TEXT,
      owner_id TEXT,
      event_time TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      external_ref TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_user_notifications_user_read
    ON user_notifications (user_id, read_at, created_at DESC);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_user_type_external_ref
    ON user_notifications (user_id, type, external_ref)
    WHERE external_ref IS NOT NULL;
  `);
}

module.exports = { createPostgresPool, resetDatabase, ensureAuthSchema };
