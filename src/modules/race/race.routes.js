async function raceRoutes(fastify) {
  const raceService = fastify.raceService;

  fastify.post('/race/plan', {
    preHandler: [fastify.authenticate],
  }, async (request) => {
    return raceService.buildPlan(request.user.id, request.body ?? {});
  });
}

module.exports = { raceRoutes };
