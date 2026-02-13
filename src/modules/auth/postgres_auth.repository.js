class PostgresAuthRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async findUserByEmail(email) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, created_at FROM users WHERE email = $1 LIMIT 1`,
      [email]
    );
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  async findUserById(id) {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, created_at FROM users WHERE id = $1 LIMIT 1`,
      [id]
    );
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  async findUserByIdentity(provider, providerUserId) {
    const result = await this.pool.query(
      `
        SELECT u.id, u.email, u.password_hash, u.created_at
        FROM user_identities ui
        JOIN users u ON u.id = ui.user_id
        WHERE ui.provider = $1 AND ui.provider_user_id = $2
        LIMIT 1
      `,
      [provider, providerUserId]
    );
    return result.rows[0] ? this.mapUser(result.rows[0]) : null;
  }

  async createUser(user) {
    const result = await this.pool.query(
      `
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id, email, password_hash, created_at
      `,
      [user.id, user.email, user.passwordHash, user.createdAt]
    );
    return this.mapUser(result.rows[0]);
  }

  async saveRefreshToken(userId, refreshToken) {
    await this.pool.query(
      `
        INSERT INTO refresh_tokens (user_id, refresh_token, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET refresh_token = EXCLUDED.refresh_token, updated_at = NOW()
      `,
      [userId, refreshToken]
    );
  }

  async linkIdentity({ userId, provider, providerUserId, email }) {
    await this.pool.query(
      `
        INSERT INTO user_identities (user_id, provider, provider_user_id, email)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider, provider_user_id)
        DO UPDATE SET email = EXCLUDED.email
        WHERE user_identities.user_id = EXCLUDED.user_id
      `,
      [userId, provider, providerUserId, email]
    );
  }

  async getRefreshToken(userId) {
    const result = await this.pool.query(
      `SELECT refresh_token FROM refresh_tokens WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    return result.rows[0]?.refresh_token ?? null;
  }

  async clearRefreshToken(userId) {
    await this.pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
  }

  mapUser(row) {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      createdAt: new Date(row.created_at).toISOString()
    };
  }
}

module.exports = { PostgresAuthRepository };
