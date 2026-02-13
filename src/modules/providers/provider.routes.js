async function providerRoutes(fastify) {
  const providerService = fastify.providerService;

  fastify.get('/providers/available', async () => {
    const providers = await providerService.getAvailableProviders();
    return { providers };
  });

  fastify.get('/providers/connections', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const connections = await providerService.getConnectedProviders(request.user.id);
    return { connections };
  });

  fastify.post('/providers/connect', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const provider = request.body?.provider;
    const connection = await providerService.connectProvider({
      userId: request.user.id,
      provider
    });
    return { connection };
  });
}

module.exports = { providerRoutes };
