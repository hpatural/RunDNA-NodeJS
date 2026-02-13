async function stravaRoutes(fastify) {
  const stravaService = fastify.stravaService;

  fastify.get('/providers/strava/oauth/start', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    return stravaService.createAuthorizationUrl(request.user.id, {
      relayUri: request.query?.relayUri
    });
  });

  fastify.get('/providers/strava/oauth/callback', async (request, reply) => {
    const { code, state, error: providerError } = request.query ?? {};
    if (providerError) {
      const err = new Error(`Strava authorization failed: ${providerError}`);
      err.statusCode = 400;
      throw err;
    }
    const result = await stravaService.exchangeCodeFromState({
      code,
      state,
      withMeta: true
    });
    if (result.relayUri) {
      const redirect = new URL(result.relayUri);
      redirect.searchParams.set('provider', 'strava');
      redirect.searchParams.set('connected', 'true');
      return reply.redirect(302, redirect.toString());
    }
    return {
      connected: true,
      provider: 'strava',
      connection: result.connection
    };
  });

  fastify.post('/providers/strava/oauth/exchange', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const code = request.body?.code;
    const connection = await stravaService.exchangeCodeForUser({
      userId: request.user.id,
      code
    });
    return {
      connected: true,
      provider: 'strava',
      connection
    };
  });

  fastify.get('/providers/strava/status', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    return stravaService.getConnectionStatus(request.user.id);
  });

  fastify.post('/providers/strava/sync', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const force = Boolean(request.body?.force);
    const result = await stravaService.syncUserActivities(request.user.id, { force });
    return { synced: true, ...result };
  });

  fastify.get('/analysis/strava', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const daysQuery = Number(request.query?.days ?? 30);
    const days = Number.isFinite(daysQuery) ? Math.max(7, Math.min(180, daysQuery)) : 30;
    return stravaService.getAnalysis(request.user.id, { days });
  });

  fastify.get('/activities/enriched', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const limit = Number(request.query?.limit ?? 20);
    const before = request.query?.before;
    return stravaService.getEnrichedActivities(request.user.id, {
      limit,
      before
    });
  });

  fastify.get('/dashboard/widgets', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const days = Number(request.query?.days ?? 70);
    const rawWidgets = String(request.query?.widgets ?? '');
    const widgetKeys = rawWidgets
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return stravaService.getDashboardWidgets(request.user.id, {
      days,
      widgetKeys
    });
  });

  fastify.get('/providers/strava/webhook', async (request) => {
    return stravaService.handleWebhookChallenge(request.query ?? {});
  });

  fastify.post('/providers/strava/webhook', async (request, reply) => {
    await stravaService.handleWebhookEvent(request.body ?? {});
    return reply.code(200).send({ received: true });
  });
}

module.exports = { stravaRoutes };
