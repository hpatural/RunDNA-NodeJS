const crypto = require('node:crypto');

const { hashPassword, verifyPassword } = require('../../lib/password');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} = require('../../lib/jwt');

class AuthService {
  constructor({ repository, env, socialTokenVerifier }) {
    this.repository = repository;
    this.env = env;
    this.socialTokenVerifier = socialTokenVerifier;
  }

  async register({ email, password }) {
    this.validateCredentials({ email, password });

    const normalizedEmail = email.trim().toLowerCase();
    if (await this.repository.findUserByEmail(normalizedEmail)) {
      const error = new Error('Account already exists');
      error.statusCode = 409;
      throw error;
    }

    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };

    const createdUser = await this.repository.createUser(user);
    return this.issueTokens(createdUser);
  }

  async login({ email, password }) {
    this.validateCredentials({ email, password, strictPassword: false });

    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.repository.findUserByEmail(normalizedEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    return this.issueTokens(user);
  }

  async refresh({ refreshToken }) {
    if (!refreshToken) {
      const error = new Error('Refresh token is required');
      error.statusCode = 400;
      throw error;
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken, this.env);
    } catch {
      const error = new Error('Invalid refresh token');
      error.statusCode = 401;
      throw error;
    }

    const stored = await this.repository.getRefreshToken(decoded.sub);
    if (!stored || stored !== refreshToken) {
      const error = new Error('Refresh token revoked');
      error.statusCode = 401;
      throw error;
    }

    const user = await this.repository.findUserById(decoded.sub);
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    return this.issueTokens(user);
  }

  async logout(userId) {
    await this.repository.clearRefreshToken(userId);
    return { success: true };
  }

  async socialLogin({ provider, idToken, email }) {
    const normalizedProvider = String(provider ?? '').trim().toLowerCase();
    if (normalizedProvider !== 'google' && normalizedProvider !== 'apple') {
      const error = new Error('Unsupported social provider');
      error.statusCode = 400;
      throw error;
    }
    if (!idToken || typeof idToken !== 'string') {
      const error = new Error('idToken is required');
      error.statusCode = 400;
      throw error;
    }

    let verifiedProfile;
    if (normalizedProvider === 'google') {
      verifiedProfile = await this.socialTokenVerifier.verifyGoogleIdToken(idToken);
    } else {
      verifiedProfile = await this.socialTokenVerifier.verifyAppleIdToken(idToken);
    }

    let user = await this.repository.findUserByIdentity(
      normalizedProvider,
      verifiedProfile.providerUserId
    );

    const normalizedEmail = this.normalizeEmail(
      verifiedProfile.email ?? email
    );

    if (!user && normalizedEmail) {
      user = await this.repository.findUserByEmail(normalizedEmail);
    }

    if (!user) {
      if (!normalizedEmail) {
        const error = new Error('Social account email is required on first login');
        error.statusCode = 400;
        throw error;
      }
      user = await this.repository.createUser({
        id: crypto.randomUUID(),
        email: normalizedEmail,
        passwordHash: hashPassword(crypto.randomUUID()),
        createdAt: new Date().toISOString()
      });
    }

    await this.repository.linkIdentity({
      userId: user.id,
      provider: normalizedProvider,
      providerUserId: verifiedProfile.providerUserId,
      email: normalizedEmail ?? user.email
    });

    return this.issueTokens(user);
  }

  sanitizeUser(user) {
    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt
    };
  }

  async issueTokens(user) {
    const payload = { sub: user.id, email: user.email };
    const accessToken = signAccessToken(payload, this.env);
    const refreshToken = signRefreshToken(payload, this.env);

    await this.repository.saveRefreshToken(user.id, refreshToken);

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
      tokenType: 'Bearer'
    };
  }

  validateCredentials({ email, password, strictPassword = true }) {
    if (!email || !String(email).includes('@')) {
      const error = new Error('Invalid email');
      error.statusCode = 400;
      throw error;
    }
    if (!password || String(password).length < (strictPassword ? 8 : 1)) {
      const error = new Error(
        strictPassword
          ? 'Password must contain at least 8 characters'
          : 'Password is required'
      );
      error.statusCode = 400;
      throw error;
    }
  }

  normalizeEmail(email) {
    if (!email || typeof email !== 'string') {
      return null;
    }
    const normalizedEmail = email.trim().toLowerCase();
    return normalizedEmail.includes('@') ? normalizedEmail : null;
  }
}

module.exports = { AuthService };
