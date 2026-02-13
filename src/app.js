const Fastify = require('fastify');
const cors = require('@fastify/cors');

const { env } = require('./config/env');
const { createPostgresPool, resetDatabase, ensureAuthSchema } = require('./db/postgres');
const authGuardPlugin = require('./plugins/auth-guard');
const { PostgresAuthRepository } = require('./modules/auth/postgres_auth.repository');
const { AuthService } = require('./modules/auth/auth.service');
const { SocialTokenVerifier } = require('./modules/auth/social_token_verifier');
const { authRoutes } = require('./modules/auth/auth.routes');
const { PostgresProviderRepository } = require('./modules/providers/postgres_provider.repository');
const { ProviderService } = require('./modules/providers/provider.service');
const { providerRoutes } = require('./modules/providers/provider.routes');
const { PostgresStravaRepository } = require('./modules/strava/postgres_strava.repository');
const { StravaApiClient } = require('./modules/strava/strava.client');
const { StravaAiClient } = require('./modules/strava/strava.ai.client');
const { StravaService } = require('./modules/strava/strava.service');
const { StravaJobs } = require('./modules/strava/strava.jobs');
const { stravaRoutes } = require('./modules/strava/strava.routes');
const { renderLandingPage } = require('./modules/landing/landing.page');

function resolveCorsOrigin(corsOrigin) {
  if (!corsOrigin || corsOrigin === '*') {
    return true;
  }

  const origins = corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : true;
}

function buildApp() {
  const app = Fastify({ logger: true });

  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required to start the API.');
  }

  const pool = createPostgresPool(env);
  const authRepository = new PostgresAuthRepository(pool);
  const providerRepository = new PostgresProviderRepository(pool);
  const stravaRepository = new PostgresStravaRepository(pool);

  app.addHook('onReady', async () => {
    if (env.dropDatabaseOnStartup) {
      app.log.warn('DROP_DATABASE_ON_STARTUP=true: dropping all application tables');
      await resetDatabase(pool);
    }
    await ensureAuthSchema(pool);
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  const socialTokenVerifier = new SocialTokenVerifier({ env });
  const authService = new AuthService({ repository: authRepository, env, socialTokenVerifier });
  const providerService = new ProviderService({ repository: providerRepository });
  const stravaClient = new StravaApiClient({ env, logger: app.log });
  const stravaAiClient = new StravaAiClient({ env, logger: app.log });
  const stravaService = new StravaService({
    repository: stravaRepository,
    providerRepository,
    client: stravaClient,
    aiClient: stravaAiClient,
    env,
    logger: app.log
  });
  const stravaJobs = new StravaJobs({ stravaService, logger: app.log, env });

  app.decorate('authService', authService);
  app.decorate('providerService', providerService);
  app.decorate('stravaService', stravaService);

  app.register(cors, { origin: resolveCorsOrigin(env.corsOrigin) });
  app.register(authGuardPlugin, { env });

  app.get('/', async (_request, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .send(renderLandingPage());
  });

  app.get('/health', async () => ({ status: 'ok', service: 'run-dna-api' }));
  app.register(authRoutes, { prefix: '/v1' });
  app.register(providerRoutes, { prefix: '/v1' });
  app.register(stravaRoutes, { prefix: '/v1' });

  app.addHook('onReady', async () => {
    stravaJobs.start();
  });

  app.addHook('onClose', async () => {
    stravaJobs.stop();
  });

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
