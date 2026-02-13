const Fastify = require('fastify');
const cors = require('@fastify/cors');

const { env } = require('./config/env');
const { createPostgresPool, ensureAuthSchema } = require('./db/postgres');
const authGuardPlugin = require('./plugins/auth-guard');
const { AuthRepository } = require('./modules/auth/auth.repository');
const { PostgresAuthRepository } = require('./modules/auth/postgres_auth.repository');
const { AuthService } = require('./modules/auth/auth.service');
const { authRoutes } = require('./modules/auth/auth.routes');
const { renderLandingPage } = require('./modules/landing/landing.page');

function buildApp() {
  const app = Fastify({ logger: true });

  let authRepository = new AuthRepository();

  if (env.databaseUrl) {
    const pool = createPostgresPool(env);
    authRepository = new PostgresAuthRepository(pool);

    app.addHook('onReady', async () => {
      await ensureAuthSchema(pool);
    });

    app.addHook('onClose', async () => {
      await pool.end();
    });
  }

  const authService = new AuthService({ repository: authRepository, env });

  app.decorate('authService', authService);

  app.register(cors, { origin: env.corsOrigin });
  app.register(authGuardPlugin, { env });

  app.get('/', async (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(renderLandingPage());
  });

  app.get('/health', async () => ({ status: 'ok', service: 'run-dna-api' }));
  app.register(authRoutes, { prefix: '/v1' });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error.statusCode && Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;

    reply.code(statusCode).send({
      error: {
        message: error.message || 'Internal server error',
        statusCode
      }
    });
  });

  return app;
}

module.exports = { buildApp, env };
