class StravaRepository {
  constructor() {
    this.connectionsByUserId = new Map();
    this.userIdByAthleteId = new Map();
    this.activitiesByUserId = new Map();
    this.webhookEvents = [];
    this.notificationsByUserId = new Map();
  }

  async upsertConnection(connection) {
    if (connection.athleteId) {
      const linkedUserId = this.userIdByAthleteId.get(String(connection.athleteId));
      if (linkedUserId && linkedUserId !== connection.userId) {
        const error = new Error(
          'This Strava account is already connected to another RunDNA account'
        );
        error.statusCode = 409;
        throw error;
      }
    }

    const nowIso = new Date().toISOString();
    const existing = this.connectionsByUserId.get(connection.userId);
    const normalized = {
      userId: connection.userId,
      athleteId: connection.athleteId,
      scope: connection.scope ?? null,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      tokenExpiresAt: connection.tokenExpiresAt,
      connectedAt: existing?.connectedAt ?? nowIso,
      updatedAt: nowIso,
      lastSyncedAt: existing?.lastSyncedAt ?? null
    };

    this.connectionsByUserId.set(connection.userId, normalized);
    if (connection.athleteId) {
      this.userIdByAthleteId.set(String(connection.athleteId), connection.userId);
    }
    return this.#sanitizeConnection(normalized);
  }

  async getConnectionByUserId(userId) {
    const connection = this.connectionsByUserId.get(userId);
    return connection ? this.#sanitizeConnection(connection) : null;
  }

  async getConnectionByAthleteId(athleteId) {
    const userId = this.userIdByAthleteId.get(String(athleteId));
    if (!userId) {
      return null;
    }
    const connection = this.connectionsByUserId.get(userId);
    return connection ? this.#sanitizeConnection(connection) : null;
  }

  async listConnectionsExpiringBefore(isoDate, limit = 100) {
    const threshold = new Date(isoDate).getTime();
    const rows = [];
    for (const connection of this.connectionsByUserId.values()) {
      if (new Date(connection.tokenExpiresAt).getTime() <= threshold) {
        rows.push(this.#sanitizeConnection(connection));
      }
    }
    return rows.slice(0, limit);
  }

  async listUsersForSync({ staleBefore, limit = 100 }) {
    const threshold = new Date(staleBefore).getTime();
    const rows = [];
    for (const connection of this.connectionsByUserId.values()) {
      if (!connection.lastSyncedAt || new Date(connection.lastSyncedAt).getTime() <= threshold) {
        rows.push(this.#sanitizeConnection(connection));
      }
    }
    return rows.slice(0, limit);
  }

  async touchLastSyncedAt(userId, isoDate) {
    const current = this.connectionsByUserId.get(userId);
    if (!current) {
      return;
    }
    current.lastSyncedAt = isoDate;
    current.updatedAt = new Date().toISOString();
  }

  async upsertActivities(userId, activities) {
    const existing = this.activitiesByUserId.get(userId) ?? [];
    const byId = new Map(existing.map((item) => [item.activityId, item]));

    for (const activity of activities) {
      byId.set(activity.activityId, activity);
    }

    const merged = Array.from(byId.values());
    this.activitiesByUserId.set(userId, merged);
    return merged.length;
  }

  async getActivities(userId, {
    startDate,
    endDate,
    limit = 1000,
    sportTypes
  } = {}) {
    const all = this.activitiesByUserId.get(userId) ?? [];
    const filtered = all.filter((item) => {
      const timestamp = new Date(item.startDate).getTime();
      if (startDate && timestamp < new Date(startDate).getTime()) {
        return false;
      }
      if (endDate && timestamp > new Date(endDate).getTime()) {
        return false;
      }
      if (Array.isArray(sportTypes) && sportTypes.length > 0) {
        if (!sportTypes.includes(item.sportType)) {
          return false;
        }
      }
      return true;
    });

    filtered.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    return filtered.slice(0, limit);
  }

  async getLatestActivityDate(userId, { sportTypes } = {}) {
    const all = this.activitiesByUserId.get(userId) ?? [];
    const filtered = Array.isArray(sportTypes) && sportTypes.length > 0
      ? all.filter((item) => sportTypes.includes(item.sportType))
      : all;
    if (filtered.length === 0) {
      return null;
    }
    const latest = filtered.reduce((acc, item) => {
      if (!acc) {
        return item;
      }
      return new Date(item.startDate).getTime() > new Date(acc.startDate).getTime() ? item : acc;
    }, null);
    return latest?.startDate ?? null;
  }

  async getActivityById(userId, activityId) {
    const all = this.activitiesByUserId.get(userId) ?? [];
    const match = all.find((item) => String(item.activityId) === String(activityId));
    return match ?? null;
  }

  async recordWebhookEvent(event) {
    this.webhookEvents.push({
      receivedAt: new Date().toISOString(),
      event
    });
  }

  async createNotification({
    userId,
    type,
    title,
    message,
    externalRef = null,
    payload = {}
  }) {
    const items = this.notificationsByUserId.get(userId) ?? [];
    if (
      externalRef &&
      items.some(
        (item) =>
          item.type === type &&
          item.externalRef === externalRef
      )
    ) {
      return;
    }
    items.push({
      type,
      title,
      message,
      externalRef,
      payload,
      createdAt: new Date().toISOString(),
      readAt: null
    });
    this.notificationsByUserId.set(userId, items);
  }

  async getUnreadNotificationSummary(userId) {
    const items = this.notificationsByUserId.get(userId) ?? [];
    return {
      unreadCount: items.filter((item) => !item.readAt).length
    };
  }

  async markNotificationsRead(userId) {
    const items = this.notificationsByUserId.get(userId) ?? [];
    const now = new Date().toISOString();
    for (const item of items) {
      if (!item.readAt) {
        item.readAt = now;
      }
    }
  }

  #sanitizeConnection(connection) {
    return {
      userId: connection.userId,
      athleteId: connection.athleteId,
      scope: connection.scope,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      tokenExpiresAt: connection.tokenExpiresAt,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
      lastSyncedAt: connection.lastSyncedAt
    };
  }
}

module.exports = { StravaRepository };
