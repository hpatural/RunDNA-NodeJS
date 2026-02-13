const jwt = require('jsonwebtoken');

function signAccessToken(payload, env) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessExpiresIn });
}

function signRefreshToken(payload, env) {
  return jwt.sign(payload, env.jwtRefreshSecret, { expiresIn: env.jwtRefreshExpiresIn });
}

function verifyAccessToken(token, env) {
  return jwt.verify(token, env.jwtAccessSecret);
}

function verifyRefreshToken(token, env) {
  return jwt.verify(token, env.jwtRefreshSecret);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
};
