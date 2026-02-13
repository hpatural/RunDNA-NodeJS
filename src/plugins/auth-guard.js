const fp = require('fastify-plugin');
const { verifyAccessToken } = require('../lib/jwt');

async function authGuardPlugin(fastify, options) {
  fastify.decorate('authenticate', async (request) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const error = new Error('Missing bearer token');
      error.statusCode = 401;
      throw error;
    }

    const token = authHeader.slice('Bearer '.length);
    try {
      const decoded = verifyAccessToken(token, options.env);
      request.user = { id: decoded.sub, email: decoded.email };
    } catch {
      const error = new Error('Invalid access token');
      error.statusCode = 401;
      throw error;
    }
  });
}

module.exports = fp(authGuardPlugin);
