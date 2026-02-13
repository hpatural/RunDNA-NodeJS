class PostgresProviderRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getAvailableProviders() {
    return ['strava', 'googleHealth', 'appleHealth'];
  }

  async getConnectedProviders(userId) {
    const result = await this.pool.query(
      `
        SELECT provider, connected_at
        FROM provider_connections
        WHERE user_id = $1
        ORDER BY connected_at DESC
      `,
      [userId]
    );
    return result.rows.map((row) => this.mapConnection(row));
  }

  async connectProvider(userId, provider) {
    const result = await this.pool.query(
      `
        INSERT INTO provider_connections (user_id, provider, connected_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (user_id, provider)
        DO UPDATE SET connected_at = NOW()
        RETURNING provider, connected_at
      `,
      [userId, provider]
    );
    return this.mapConnection(result.rows[0]);
  }

  async getUserById(userId) {
    const result = await this.pool.query(
      `
        SELECT id, email
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );
    if (!result.rows[0]) {
      return null;
    }
    return {
      id: result.rows[0].id,
      email: result.rows[0].email
    };
  }

  mapConnection(row) {
    return {
      provider: row.provider,
      connectedAt: new Date(row.connected_at).toISOString()
    };
  }
}

module.exports = { PostgresProviderRepository };
