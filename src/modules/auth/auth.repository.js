class AuthRepository {
  constructor() {
    this.usersByEmail = new Map();
    this.usersById = new Map();
    this.refreshByUserId = new Map();
  }

  findUserByEmail(email) {
    return this.usersByEmail.get(email) ?? null;
  }

  findUserById(id) {
    return this.usersById.get(id) ?? null;
  }

  createUser(user) {
    this.usersByEmail.set(user.email, user);
    this.usersById.set(user.id, user);
    return user;
  }

  saveRefreshToken(userId, refreshToken) {
    this.refreshByUserId.set(userId, refreshToken);
  }

  getRefreshToken(userId) {
    return this.refreshByUserId.get(userId) ?? null;
  }

  clearRefreshToken(userId) {
    this.refreshByUserId.delete(userId);
  }
}

module.exports = { AuthRepository };
