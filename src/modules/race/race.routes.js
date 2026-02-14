async function raceRoutes(fastify) {
  const raceService = fastify.raceService;

  fastify.post('/race/plan', {
    preHandler: [fastify.authenticate],
  }, async (request) => {
    const locale = request.body?.locale ?? request.headers['accept-language'];
    return raceService.buildPlan(request.user.id, {
      ...(request.body ?? {}),
      locale,
    });
  });
}

module.exports = { raceRoutes };
