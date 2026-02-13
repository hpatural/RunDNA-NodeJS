const { buildApp, env } = require('./app');

async function start() {
  const app = buildApp();

  try {
    await app.listen({ port: env.port, host: env.host });
    app.log.info(`API listening on ${env.host}:${env.port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
