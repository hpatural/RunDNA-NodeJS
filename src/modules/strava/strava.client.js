class StravaApiClient {
  constructor({ env, logger }) {
    this.env = env;
    this.logger = logger;
  }

  isConfigured() {
    return Boolean(
      this.env.stravaClientId &&
        this.env.stravaClientSecret &&
        this.env.stravaRedirectUri
    );
  }

  buildAuthorizationUrl({ state }) {
    const url = new URL('/oauth/authorize', this.env.stravaBaseUrl);
    url.searchParams.set('client_id', this.env.stravaClientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.env.stravaRedirectUri);
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', this.env.stravaScope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCodeForToken(code) {
    return this.#requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.env.stravaRedirectUri
    });
  }

  async refreshAccessToken(refreshToken) {
    return this.#requestToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
  }

  async fetchAthleteActivities(accessToken, { after, before, page = 1, perPage = 100 } = {}) {
    const url = new URL('/api/v3/athlete/activities', this.env.stravaBaseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(Math.min(perPage, 200)));
    if (after) {
      url.searchParams.set('after', String(after));
    }
    if (before) {
      url.searchParams.set('before', String(before));
    }

    const response = await this.#fetchJson(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!Array.isArray(response)) {
      throw this.#buildApiError('Unexpected Strava activities response', 502);
    }

    return response;
  }

  async fetchActivityDetails(accessToken, activityId) {
    const url = new URL(`/api/v3/activities/${encodeURIComponent(String(activityId))}`, this.env.stravaBaseUrl);
    url.searchParams.set('include_all_efforts', 'true');

    const response = await this.#fetchJson(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response || typeof response !== 'object') {
      throw this.#buildApiError('Unexpected Strava activity detail response', 502);
    }

    return response;
  }

  async #requestToken(body) {
    const payload = {
      ...body,
      client_id: this.env.stravaClientId,
      client_secret: this.env.stravaClientSecret
    };

    const response = await this.#fetchJson(new URL('/oauth/token', this.env.stravaBaseUrl).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response?.access_token || !response?.refresh_token || !response?.expires_at) {
      throw this.#buildApiError('Invalid token response from Strava', 502);
    }

    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(response.expires_at * 1000).toISOString(),
      scope: response.scope ?? null,
      athleteId: response.athlete?.id ? String(response.athlete.id) : null
    };
  }

  async #fetchJson(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to reach Strava API');
      throw this.#buildApiError('Unable to reach Strava API', 502);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.message || payload?.errors?.[0]?.message || 'Strava API error';
      const status = response.status >= 500 ? 502 : 400;
      throw this.#buildApiError(message, status, payload);
    }

    return payload;
  }

  #buildApiError(message, statusCode, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details) {
      error.details = details;
    }
    return error;
  }
}

module.exports = { StravaApiClient };
