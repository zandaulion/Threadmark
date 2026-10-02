import { createThreadmarkServer } from './server.mjs';

const app = createThreadmarkServer();
app.server.listen(app.config.port, app.config.host, () => {
  console.log(`Threadmark listening on http://${app.config.host}:${app.config.port}`);
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
