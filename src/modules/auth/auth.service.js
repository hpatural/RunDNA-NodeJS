const crypto = require('node:crypto');

const { hashPassword, verifyPassword } = require('../../lib/password');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken
} = require('../../lib/jwt');

class AuthService {
  constructor({ repository, env }) {
    this.repository = repository;
    this.env = env;
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
}

module.exports = { AuthService };
