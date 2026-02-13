const jwt = require('jsonwebtoken');
const { analyzeStravaActivities } = require('./strava.analysis');
const {
  toEnrichedActivity,
  buildDashboardData,
  pickWidgets
} = require('./strava.mobile');

const SUPPORTED_STRAVA_SPORTS = ['Run', 'TrailRun'];

class StravaService {
  constructor({ repository, providerRepository, client, env, logger }) {
    this.repository = repository;
    this.providerRepository = providerRepository;
    this.client = client;
    this.env = env;
    this.logger = logger;
  }

  isConfigured() {
    return this.client.isConfigured();
  }

  ensureConfigured() {
    if (!this.isConfigured()) {
      const error = new Error('Strava OAuth is not configured on server');
      error.statusCode = 503;
      throw error;
    }
  }

  createAuthorizationUrl(userId, { relayUri } = {}) {
    this.ensureConfigured();
    const normalizedRelayUri = this.#normalizeRelayUri(relayUri);
    const state = jwt.sign(
      {
        sub: userId,
        provider: 'strava',
        relayUri: normalizedRelayUri
      },
      this.env.stravaStateSecret,
      { expiresIn: '10m' }
    );

    return {
      state,
      authorizationUrl: this.client.buildAuthorizationUrl({ state })
    };
  }

  async exchangeCodeForUser({ userId, code }) {
    this.ensureConfigured();
    if (!code || typeof code !== 'string') {
      const error = new Error('Missing Strava authorization code');
      error.statusCode = 400;
      throw error;
    }

    const tokenData = await this.client.exchangeCodeForToken(code);
    if (tokenData.athleteId) {
      const existingForAthlete = await this.repository.getConnectionByAthleteId(
        tokenData.athleteId
      );
      if (existingForAthlete && existingForAthlete.userId !== userId) {
        const error = new Error(
          'This Strava account is already connected to another RunDNA account'
        );
        error.statusCode = 409;
        throw error;
      }
    }

    const connection = await this.repository.upsertConnection({
      userId,
      athleteId: tokenData.athleteId,
      scope: tokenData.scope,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenExpiresAt: tokenData.expiresAt
    });
    await this.providerRepository.connectProvider(userId, 'strava');
    return this.#sanitizeConnection(connection);
  }

  async exchangeCodeFromState({ code, state, withMeta = false }) {
    this.ensureConfigured();
    if (!state || typeof state !== 'string') {
      const error = new Error('Missing OAuth state');
      error.statusCode = 400;
      throw error;
    }

    let decoded;
    try {
      decoded = jwt.verify(state, this.env.stravaStateSecret);
    } catch (_error) {
      const error = new Error('Invalid or expired OAuth state');
      error.statusCode = 400;
      throw error;
    }

    if (decoded.provider !== 'strava' || !decoded.sub) {
      const error = new Error('Invalid OAuth state payload');
      error.statusCode = 400;
      throw error;
    }

    const connection = await this.exchangeCodeForUser({
      userId: decoded.sub,
      code
    });
    if (!withMeta) {
      return connection;
    }
    return {
      connection,
      relayUri: this.#normalizeRelayUri(decoded.relayUri)
    };
  }

  async getConnectionStatus(userId) {
    const connection = await this.repository.getConnectionByUserId(userId);
    if (!connection) {
      return {
        connected: false
      };
    }

    return {
      connected: true,
      connection: this.#sanitizeConnection(connection)
    };
  }

  async syncUserActivities(userId, { force = false } = {}) {
    this.ensureConfigured();
    const baseConnection = await this.repository.getConnectionByUserId(userId);
    if (!baseConnection) {
      const error = new Error('Strava account is not connected');
      error.statusCode = 404;
      throw error;
    }

    const connection = await this.#ensureFreshAccessToken(baseConnection, force);
    const latestActivityDate = await this.repository.getLatestActivityDate(userId, {
      sportTypes: SUPPORTED_STRAVA_SPORTS
    });
    const after = latestActivityDate
      ? Math.floor(new Date(latestActivityDate).getTime() / 1000) + 1
      : Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

    let page = 1;
    const collected = [];
    while (page <= this.env.stravaSyncMaxPages) {
      const pageItems = await this.client.fetchAthleteActivities(connection.accessToken, {
        after,
        page,
        perPage: 100
      });
      if (pageItems.length === 0) {
        break;
      }
      const runnableItems = pageItems.filter((item) => this.#isSupportedSport(item));
      collected.push(...runnableItems.map((item) => this.#mapStravaActivity(item)));
      if (pageItems.length < 100) {
        break;
      }
      page += 1;
    }

    const upsertedCount = await this.repository.upsertActivities(userId, collected);
    const syncedAt = new Date().toISOString();
    await this.repository.touchLastSyncedAt(userId, syncedAt);
    await this.providerRepository.connectProvider(userId, 'strava');

    return {
      upsertedCount,
      fetchedCount: collected.length,
      syncedAt
    };
  }

  async getAnalysis(userId, { days = 30 } = {}) {
    await this.#autoSyncOnRead(userId);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const activities = await this.repository.getActivities(userId, {
      startDate,
      limit: 2000,
      sportTypes: SUPPORTED_STRAVA_SPORTS
    });
    return {
      days,
      activityCount: activities.length,
      analysis: analyzeStravaActivities(activities)
    };
  }

  async getEnrichedActivities(userId, { limit = 20, before } = {}) {
    await this.#autoSyncOnRead(userId);
    const normalizedLimit = Math.max(1, Math.min(60, Number(limit) || 20));
    let beforeIso;
    if (before) {
      const parsed = new Date(before);
      if (Number.isNaN(parsed.getTime())) {
        const error = new Error('Invalid before cursor');
        error.statusCode = 400;
        throw error;
      }
      beforeIso = parsed.toISOString();
    }
    const rows = await this.repository.getActivities(userId, {
      endDate: beforeIso,
      limit: normalizedLimit + 1,
      sportTypes: SUPPORTED_STRAVA_SPORTS
    });

    const pageItems = rows.slice(0, normalizedLimit);
    return {
      activities: pageItems.map((activity) => toEnrichedActivity(activity)),
      nextBefore: rows.length > normalizedLimit
        ? pageItems[pageItems.length - 1]?.startDate ?? null
        : null
    };
  }

  async getDashboardWidgets(userId, { days = 70, widgetKeys = [] } = {}) {
    await this.#autoSyncOnRead(userId);
    const normalizedDays = Math.max(14, Math.min(180, Number(days) || 70));
    const startDate = new Date(Date.now() - normalizedDays * 24 * 60 * 60 * 1000).toISOString();
    const activities = await this.repository.getActivities(userId, {
      startDate,
      limit: 2400,
      sportTypes: SUPPORTED_STRAVA_SPORTS
    });
    const analysis = analyzeStravaActivities(activities);
    const user = await this.providerRepository.getUserById(userId);
    const dashboard = buildDashboardData({
      userEmail: user?.email,
      activities,
      analysis
    });
    return {
      widgets: pickWidgets(dashboard, widgetKeys),
      generatedAt: new Date().toISOString(),
      days: normalizedDays
    };
  }

  handleWebhookChallenge(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || token !== this.env.stravaWebhookVerifyToken || !challenge) {
      const error = new Error('Invalid Strava webhook verification request');
      error.statusCode = 400;
      throw error;
    }

    return { 'hub.challenge': challenge };
  }

  async handleWebhookEvent(event) {
    await this.repository.recordWebhookEvent(event);

    if (event?.object_type !== 'activity' || !event?.owner_id) {
      return { accepted: true, action: 'ignored' };
    }

    const connection = await this.repository.getConnectionByAthleteId(String(event.owner_id));
    if (!connection) {
      return { accepted: true, action: 'unknown_athlete' };
    }

    if (event.aspect_type === 'create' && event.object_id) {
      await this.repository.createNotification({
        userId: connection.userId,
        type: 'strava.new_activity',
        title: 'Nouvelle activite Strava',
        message: 'Une nouvelle seance a ete detectee sur Strava.',
        externalRef: String(event.object_id),
        payload: {
          objectId: String(event.object_id),
          ownerId: String(event.owner_id)
        }
      });
    }

    try {
      await this.syncUserActivities(connection.userId, { force: false });
    } catch (error) {
      this.logger.error({ err: error, userId: connection.userId }, 'Failed to sync Strava after webhook');
    }

    return { accepted: true, action: 'synced' };
  }

  async refreshExpiringConnections() {
    if (!this.isConfigured()) {
      return { checked: 0, refreshed: 0 };
    }

    const threshold = new Date(
      Date.now() + this.env.stravaTokenRefreshBufferSeconds * 1000
    ).toISOString();
    const expiring = await this.repository.listConnectionsExpiringBefore(threshold, 200);

    let refreshed = 0;
    for (const connection of expiring) {
      try {
        await this.#refreshConnectionTokens(connection);
        refreshed += 1;
      } catch (error) {
        this.logger.error({ err: error, userId: connection.userId }, 'Unable to refresh Strava token');
      }
    }

    return { checked: expiring.length, refreshed };
  }

  async syncStaleUsers() {
    if (!this.isConfigured()) {
      return { checked: 0, synced: 0 };
    }

    const staleBefore = new Date(
      Date.now() - this.env.stravaSyncIntervalMinutes * 60 * 1000
    ).toISOString();
    const users = await this.repository.listUsersForSync({
      staleBefore,
      limit: 100
    });

    let synced = 0;
    for (const connection of users) {
      try {
        await this.syncUserActivities(connection.userId, { force: false });
        synced += 1;
      } catch (error) {
        this.logger.error({ err: error, userId: connection.userId }, 'Scheduled Strava sync failed');
      }
    }

    return { checked: users.length, synced };
  }

  async getUnreadNotificationSummary(userId) {
    return this.repository.getUnreadNotificationSummary(userId);
  }

  async markNotificationsRead(userId) {
    await this.repository.markNotificationsRead(userId);
    return { success: true };
  }

  async #ensureFreshAccessToken(connection, force) {
    const expiresAtMs = new Date(connection.tokenExpiresAt).getTime();
    const refreshThresholdMs = Date.now() + this.env.stravaTokenRefreshBufferSeconds * 1000;
    if (!force && expiresAtMs > refreshThresholdMs) {
      return connection;
    }
    return this.#refreshConnectionTokens(connection);
  }

  async #autoSyncOnRead(userId) {
    if (!this.env.stravaAutoSyncOnRead || !this.isConfigured()) {
      return;
    }

    const connection = await this.repository.getConnectionByUserId(userId);
    if (!connection) {
      return;
    }

    const staleMinutes = Math.max(1, this.env.stravaAutoSyncReadStaleMinutes);
    const staleThresholdMs = Date.now() - staleMinutes * 60 * 1000;
    const lastSyncedMs = connection.lastSyncedAt
      ? new Date(connection.lastSyncedAt).getTime()
      : 0;

    if (lastSyncedMs > staleThresholdMs) {
      return;
    }

    try {
      await this.syncUserActivities(userId, { force: false });
    } catch (error) {
      this.logger.warn(
        { err: error, userId },
        'Auto sync on read failed; returning available activities'
      );
    }
  }

  async #refreshConnectionTokens(connection) {
    const tokenData = await this.client.refreshAccessToken(connection.refreshToken);
    return this.repository.upsertConnection({
      userId: connection.userId,
      athleteId: tokenData.athleteId || connection.athleteId,
      scope: tokenData.scope || connection.scope,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      tokenExpiresAt: tokenData.expiresAt
    });
  }

  #sanitizeConnection(connection) {
    return {
      athleteId: connection.athleteId,
      scope: connection.scope,
      tokenExpiresAt: connection.tokenExpiresAt,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
      lastSyncedAt: connection.lastSyncedAt
    };
  }

  #mapStravaActivity(activity) {
    return {
      activityId: String(activity.id),
      name: activity.name ?? '',
      sportType: activity.sport_type ?? null,
      type: activity.type ?? null,
      startDate: new Date(activity.start_date).toISOString(),
      timezone: activity.timezone ?? null,
      movingTimeSec: Number(activity.moving_time ?? 0),
      elapsedTimeSec: Number(activity.elapsed_time ?? 0),
      distanceM: Number(activity.distance ?? 0),
      totalElevationGainM: Number(activity.total_elevation_gain ?? 0),
      averageSpeedMps: Number(activity.average_speed ?? 0),
      maxSpeedMps: Number(activity.max_speed ?? 0),
      averageHeartRate: activity.average_heartrate ?? null,
      maxHeartRate: activity.max_heartrate ?? null,
      trainer: Boolean(activity.trainer),
      commute: Boolean(activity.commute),
      manual: Boolean(activity.manual),
      kudosCount: Number(activity.kudos_count ?? 0),
      achievementCount: Number(activity.achievement_count ?? 0),
      rawPayload: activity
    };
  }

  #isSupportedSport(activity) {
    const sportType = String(activity?.sport_type ?? activity?.type ?? '');
    return SUPPORTED_STRAVA_SPORTS.includes(sportType);
  }

  #normalizeRelayUri(relayUri) {
    if (!relayUri || typeof relayUri !== 'string') {
      return null;
    }
    try {
      const parsed = new URL(relayUri);
      if (parsed.protocol !== 'rundna:') {
        return null;
      }
      return parsed.toString();
    } catch (_error) {
      return null;
    }
  }
}

module.exports = { StravaService };
