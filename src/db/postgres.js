const { Pool } = require('pg');

function createPostgresPool(env) {
  return new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl ? { rejectUnauthorized: false } : false
  });
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
}

module.exports = { createPostgresPool, ensureAuthSchema };
