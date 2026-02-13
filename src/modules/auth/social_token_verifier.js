const jwt = require('jsonwebtoken');
const { createPublicKey } = require('node:crypto');

const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

class SocialTokenVerifier {
  constructor({ env }) {
    this.env = env;
    this.appleJwksCache = { keys: [], fetchedAt: 0 };
  }

  async verifyGoogleIdToken(idToken) {
    if (!idToken) {
      return this.#badRequest('Google idToken is required');
    }

    const url = new URL(GOOGLE_TOKENINFO_URL);
    url.searchParams.set('id_token', idToken);
    const payload = await this.#fetchJson(url.toString(), { timeoutMs: 8_000 });

    const issuer = String(payload.iss ?? '');
    const aud = String(payload.aud ?? '');
    const sub = String(payload.sub ?? '');
    const email = this.#normalizeEmail(payload.email);
    const emailVerified = this.#asBoolean(payload.email_verified);

    if (!sub) {
      return this.#unauthorized('Invalid Google token (missing sub)');
    }
    if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
      return this.#unauthorized('Invalid Google token issuer');
    }
    if (!this.#isAllowedAudience(aud, this.env.googleOauthClientIds)) {
      return this.#unauthorized('Google token audience is not allowed');
    }

    return {
      provider: 'google',
      providerUserId: sub,
      email,
      emailVerified
    };
  }

  async verifyAppleIdToken(idToken) {
    if (!idToken) {
      return this.#badRequest('Apple idToken is required');
    }

    const decodedHeader = jwt.decode(idToken, { complete: true })?.header ?? {};
    const kid = decodedHeader.kid;
    const alg = decodedHeader.alg;
    if (!kid || alg !== 'RS256') {
      return this.#unauthorized('Invalid Apple token header');
    }

    const keys = await this.#getAppleKeys();
    const jwk = keys.find((item) => item.kid === kid && item.kty === 'RSA');
    if (!jwk) {
      return this.#unauthorized('Unable to find Apple signing key');
    }

    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    let payload;
    try {
      payload = jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: this.env.appleOauthAudiences.length > 0
          ? this.env.appleOauthAudiences
          : undefined
      });
    } catch {
      return this.#unauthorized('Invalid Apple token');
    }

    const sub = String(payload.sub ?? '');
    if (!sub) {
      return this.#unauthorized('Invalid Apple token (missing sub)');
    }

    return {
      provider: 'apple',
      providerUserId: sub,
      email: this.#normalizeEmail(payload.email),
      emailVerified: this.#asBoolean(payload.email_verified)
    };
  }

  async #getAppleKeys() {
    const now = Date.now();
    const isFresh = this.appleJwksCache.keys.length > 0 &&
      (now - this.appleJwksCache.fetchedAt) < (6 * 60 * 60 * 1000);
    if (isFresh) {
      return this.appleJwksCache.keys;
    }

    const data = await this.#fetchJson(APPLE_JWKS_URL, { timeoutMs: 8_000 });
    const keys = Array.isArray(data.keys) ? data.keys : [];
    if (keys.length === 0) {
      return this.#unauthorized('Invalid Apple JWKS response');
    }
    this.appleJwksCache = { keys, fetchedAt: now };
    return keys;
  }

  async #fetchJson(url, { timeoutMs }) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      return this.#upstreamError('Failed to reach social auth provider');
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok || !body || typeof body !== 'object') {
      return this.#unauthorized('Invalid social token');
    }

    return body;
  }

  #isAllowedAudience(aud, allowedAudiences) {
    if (!aud) {
      return false;
    }
    if (!Array.isArray(allowedAudiences) || allowedAudiences.length === 0) {
      return true;
    }
    return allowedAudiences.includes(aud);
  }

  #normalizeEmail(rawEmail) {
    if (typeof rawEmail !== 'string') {
      return null;
    }
    const email = rawEmail.trim().toLowerCase();
    return email.includes('@') ? email : null;
  }

  #asBoolean(raw) {
    if (typeof raw === 'boolean') {
      return raw;
    }
    if (typeof raw === 'string') {
      return raw === 'true' || raw === '1';
    }
    return false;
  }

  #badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  #unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    throw error;
  }

  #upstreamError(message) {
    const error = new Error(message);
    error.statusCode = 502;
    throw error;
  }
}

module.exports = { SocialTokenVerifier };
