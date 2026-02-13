async function authRoutes(fastify) {
  const authService = fastify.authService;

  fastify.post('/auth/register', async (request, reply) => {
    const result = await authService.register(request.body ?? {});
    return reply.code(201).send(result);
  });

  fastify.post('/auth/login', async (request) => {
    return authService.login(request.body ?? {});
  });

  fastify.post('/auth/refresh', async (request) => {
    return authService.refresh(request.body ?? {});
  });

  fastify.post('/auth/logout', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    return authService.logout(request.user.id);
  });

  fastify.get('/me', {
    preHandler: [fastify.authenticate]
  }, async (request) => {
    const user = await authService.repository.findUserById(request.user.id);
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }
    return { user: authService.sanitizeUser(user) };
  });
}

module.exports = { authRoutes };
