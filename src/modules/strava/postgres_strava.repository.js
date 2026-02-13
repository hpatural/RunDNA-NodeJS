class PostgresStravaRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async upsertConnection(connection) {
    if (connection.athleteId) {
      const existing = await this.getConnectionByAthleteId(connection.athleteId);
      if (existing && existing.userId !== connection.userId) {
        const domainError = new Error(
          'This Strava account is already connected to another RunDNA account'
        );
        domainError.statusCode = 409;
        throw domainError;
      }
    }

    try {
      const result = await this.pool.query(
        `
          INSERT INTO strava_connections (
            user_id,
            athlete_id,
            scope,
            access_token,
            refresh_token,
            token_expires_at,
            connected_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            athlete_id = EXCLUDED.athlete_id,
            scope = EXCLUDED.scope,
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            token_expires_at = EXCLUDED.token_expires_at,
            updated_at = NOW()
          RETURNING user_id, athlete_id, scope, access_token, refresh_token, token_expires_at, connected_at, updated_at, last_synced_at
        `,
        [
          connection.userId,
          connection.athleteId,
          connection.scope,
          connection.accessToken,
          connection.refreshToken,
          connection.tokenExpiresAt
        ]
      );
      return this.#mapConnection(result.rows[0]);
    } catch (error) {
      if (
        error?.code === '23505' &&
        String(error?.constraint || '').includes('idx_strava_connections_athlete_id')
      ) {
        const domainError = new Error(
          'This Strava account is already connected to another RunDNA account'
        );
        domainError.statusCode = 409;
        throw domainError;
      }
      throw error;
    }
  }

  async getConnectionByUserId(userId) {
    const result = await this.pool.query(
      `
        SELECT user_id, athlete_id, scope, access_token, refresh_token, token_expires_at, connected_at, updated_at, last_synced_at
        FROM strava_connections
        WHERE user_id = $1
      `,
      [userId]
    );
    return result.rows[0] ? this.#mapConnection(result.rows[0]) : null;
  }

  async getConnectionByAthleteId(athleteId) {
    const result = await this.pool.query(
      `
        SELECT user_id, athlete_id, scope, access_token, refresh_token, token_expires_at, connected_at, updated_at, last_synced_at
        FROM strava_connections
        WHERE athlete_id = $1
      `,
      [athleteId]
    );
    return result.rows[0] ? this.#mapConnection(result.rows[0]) : null;
  }

  async listConnectionsExpiringBefore(isoDate, limit = 100) {
    const result = await this.pool.query(
      `
        SELECT user_id, athlete_id, scope, access_token, refresh_token, token_expires_at, connected_at, updated_at, last_synced_at
        FROM strava_connections
        WHERE token_expires_at <= $1
        ORDER BY token_expires_at ASC
        LIMIT $2
      `,
      [isoDate, limit]
    );
    return result.rows.map((row) => this.#mapConnection(row));
  }

  async listUsersForSync({ staleBefore, limit = 100 }) {
    const result = await this.pool.query(
      `
        SELECT user_id, athlete_id, scope, access_token, refresh_token, token_expires_at, connected_at, updated_at, last_synced_at
        FROM strava_connections
        WHERE last_synced_at IS NULL OR last_synced_at <= $1
        ORDER BY COALESCE(last_synced_at, connected_at) ASC
        LIMIT $2
      `,
      [staleBefore, limit]
    );
    return result.rows.map((row) => this.#mapConnection(row));
  }

  async touchLastSyncedAt(userId, isoDate) {
    await this.pool.query(
      `
        UPDATE strava_connections
        SET last_synced_at = $2, updated_at = NOW()
        WHERE user_id = $1
      `,
      [userId, isoDate]
    );
  }

  async upsertActivities(userId, activities) {
    if (activities.length === 0) {
      return 0;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const activity of activities) {
        await client.query(
          `
            INSERT INTO strava_activities (
              user_id,
              activity_id,
              name,
              sport_type,
              type,
              start_date,
              timezone,
              moving_time_sec,
              elapsed_time_sec,
              distance_m,
              total_elevation_gain_m,
              average_speed_mps,
              max_speed_mps,
              average_heartrate,
              max_heartrate,
              relative_effort_score,
              trainer,
              commute,
              manual,
              kudos_count,
              achievement_count,
              raw_payload,
              synced_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW()
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              user_id = EXCLUDED.user_id,
              name = EXCLUDED.name,
              sport_type = EXCLUDED.sport_type,
              type = EXCLUDED.type,
              start_date = EXCLUDED.start_date,
              timezone = EXCLUDED.timezone,
              moving_time_sec = EXCLUDED.moving_time_sec,
              elapsed_time_sec = EXCLUDED.elapsed_time_sec,
              distance_m = EXCLUDED.distance_m,
              total_elevation_gain_m = EXCLUDED.total_elevation_gain_m,
              average_speed_mps = EXCLUDED.average_speed_mps,
              max_speed_mps = EXCLUDED.max_speed_mps,
              average_heartrate = EXCLUDED.average_heartrate,
              max_heartrate = EXCLUDED.max_heartrate,
              relative_effort_score = EXCLUDED.relative_effort_score,
              trainer = EXCLUDED.trainer,
              commute = EXCLUDED.commute,
              manual = EXCLUDED.manual,
              kudos_count = EXCLUDED.kudos_count,
              achievement_count = EXCLUDED.achievement_count,
              raw_payload = EXCLUDED.raw_payload,
              synced_at = NOW()
          `,
          [
            userId,
            activity.activityId,
            activity.name,
            activity.sportType,
            activity.type,
            activity.startDate,
            activity.timezone,
            activity.movingTimeSec,
            activity.elapsedTimeSec,
            activity.distanceM,
            activity.totalElevationGainM,
            activity.averageSpeedMps,
            activity.maxSpeedMps,
            activity.averageHeartRate,
            activity.maxHeartRate,
            activity.relativeEffortScore,
            activity.trainer,
            activity.commute,
            activity.manual,
            activity.kudosCount,
            activity.achievementCount,
            activity.rawPayload
          ]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return activities.length;
  }

  async getActivities(userId, {
    startDate,
    endDate,
    limit = 1000,
    sportTypes
  } = {}) {
    const conditions = ['user_id = $1'];
    const params = [userId];

    if (startDate) {
      params.push(startDate);
      conditions.push(`start_date >= $${params.length}`);
    }
    if (endDate) {
      params.push(endDate);
      conditions.push(`start_date <= $${params.length}`);
    }
    if (Array.isArray(sportTypes) && sportTypes.length > 0) {
      params.push(sportTypes);
      conditions.push(`sport_type = ANY($${params.length}::text[])`);
    }
    params.push(limit);

    const result = await this.pool.query(
      `
        SELECT activity_id, name, sport_type, type, start_date, timezone,
               moving_time_sec, elapsed_time_sec, distance_m, total_elevation_gain_m,
               average_speed_mps, max_speed_mps, average_heartrate, max_heartrate, relative_effort_score,
               raw_payload,
               trainer, commute, manual, kudos_count, achievement_count
        FROM strava_activities
        WHERE ${conditions.join(' AND ')}
        ORDER BY start_date DESC
        LIMIT $${params.length}
      `,
      params
    );

    return result.rows.map((row) => this.#mapActivity(row));
  }

  async getLatestActivityDate(userId, { sportTypes } = {}) {
    const conditions = ['user_id = $1'];
    const params = [userId];
    if (Array.isArray(sportTypes) && sportTypes.length > 0) {
      params.push(sportTypes);
      conditions.push(`sport_type = ANY($${params.length}::text[])`);
    }

    const result = await this.pool.query(
      `
        SELECT start_date
        FROM strava_activities
        WHERE ${conditions.join(' AND ')}
        ORDER BY start_date DESC
        LIMIT 1
      `,
      params
    );
    if (!result.rows[0]) {
      return null;
    }
    return new Date(result.rows[0].start_date).toISOString();
  }

  async getActivityById(userId, activityId) {
    const result = await this.pool.query(
      `
        SELECT activity_id, name, sport_type, type, start_date, timezone,
               moving_time_sec, elapsed_time_sec, distance_m, total_elevation_gain_m,
               average_speed_mps, max_speed_mps, average_heartrate, max_heartrate, relative_effort_score,
               raw_payload, trainer, commute, manual, kudos_count, achievement_count
        FROM strava_activities
        WHERE user_id = $1 AND activity_id = $2
        LIMIT 1
      `,
      [userId, activityId]
    );
    return result.rows[0] ? this.#mapActivity(result.rows[0]) : null;
  }

  async recordWebhookEvent(event) {
    await this.pool.query(
      `
        INSERT INTO strava_webhook_events (
          object_type,
          object_id,
          aspect_type,
          owner_id,
          event_time,
          payload
        )
        VALUES ($1, $2, $3, $4, to_timestamp($5), $6::jsonb)
      `,
      [
        event.object_type ?? null,
        event.object_id ?? null,
        event.aspect_type ?? null,
        event.owner_id ?? null,
        Number(event.event_time ?? Math.floor(Date.now() / 1000)),
        JSON.stringify(event)
      ]
    );
  }

  async createNotification({
    userId,
    type,
    title,
    message,
    externalRef = null,
    payload = {}
  }) {
    try {
      await this.pool.query(
        `
          INSERT INTO user_notifications (
            user_id, type, title, message, external_ref, payload, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
        `,
        [
          userId,
          type,
          title,
          message,
          externalRef,
          JSON.stringify(payload)
        ]
      );
    } catch (error) {
      if (
        error?.code === '23505' &&
        String(error?.constraint || '').includes('idx_user_notifications_user_type_external_ref')
      ) {
        return;
      }
      throw error;
    }
  }

  async getUnreadNotificationSummary(userId) {
    const result = await this.pool.query(
      `
        SELECT COUNT(*)::int AS unread_count
        FROM user_notifications
        WHERE user_id = $1
          AND read_at IS NULL
      `,
      [userId]
    );
    return {
      unreadCount: result.rows[0]?.unread_count ?? 0
    };
  }

  async markNotificationsRead(userId) {
    await this.pool.query(
      `
        UPDATE user_notifications
        SET read_at = NOW()
        WHERE user_id = $1
          AND read_at IS NULL
      `,
      [userId]
    );
  }

  #mapConnection(row) {
    return {
      userId: row.user_id,
      athleteId: row.athlete_id,
      scope: row.scope,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      tokenExpiresAt: new Date(row.token_expires_at).toISOString(),
      connectedAt: new Date(row.connected_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null
    };
  }

  #mapActivity(row) {
    return {
      activityId: String(row.activity_id),
      name: row.name,
      sportType: row.sport_type,
      type: row.type,
      startDate: new Date(row.start_date).toISOString(),
      timezone: row.timezone,
      movingTimeSec: row.moving_time_sec,
      elapsedTimeSec: row.elapsed_time_sec,
      distanceM: Number(row.distance_m ?? 0),
      totalElevationGainM: Number(row.total_elevation_gain_m ?? 0),
      averageSpeedMps: row.average_speed_mps ? Number(row.average_speed_mps) : 0,
      maxSpeedMps: row.max_speed_mps ? Number(row.max_speed_mps) : 0,
      averageHeartRate: row.average_heartrate ? Number(row.average_heartrate) : null,
      maxHeartRate: row.max_heartrate ? Number(row.max_heartrate) : null,
      relativeEffortScore: row.relative_effort_score ? Number(row.relative_effort_score) : null,
      rawPayload: row.raw_payload ?? null,
      trainer: Boolean(row.trainer),
      commute: Boolean(row.commute),
      manual: Boolean(row.manual),
      kudosCount: row.kudos_count ?? 0,
      achievementCount: row.achievement_count ?? 0
    };
  }
}

module.exports = { PostgresStravaRepository };
