class StravaJobs {
  constructor({ stravaService, logger, env }) {
    this.stravaService = stravaService;
    this.logger = logger;
    this.env = env;
    this.refreshTimer = null;
    this.syncTimer = null;
  }

  start() {
    if (!this.stravaService.isConfigured()) {
      this.logger.warn('Strava jobs are disabled: missing Strava server configuration');
      return;
    }

    const refreshIntervalMs = Math.max(60_000, this.env.stravaTokenRefreshIntervalMinutes * 60 * 1000);
    const syncIntervalMs = Math.max(60_000, this.env.stravaSyncIntervalMinutes * 60 * 1000);

    this.refreshTimer = setInterval(async () => {
      const result = await this.stravaService.refreshExpiringConnections();
      this.logger.info({ result }, 'Strava token refresh cycle complete');
    }, refreshIntervalMs);

    if (this.env.stravaEnableScheduledSync) {
      this.syncTimer = setInterval(async () => {
        const result = await this.stravaService.syncStaleUsers();
        this.logger.info({ result }, 'Strava background sync cycle complete');
      }, syncIntervalMs);
    }

    this.refreshTimer.unref();
    if (this.syncTimer) {
      this.syncTimer.unref();
    }
  }

  stop() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}

module.exports = { StravaJobs };
