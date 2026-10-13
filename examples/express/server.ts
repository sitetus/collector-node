import { createApp } from './app.js';

/**
 * `node examples/express/server.js` after `npx sitetus-collector pair <code>`:
 * the configuration is read from ./sitetus.collector.json (or the
 * SITETUS_COLLECTOR_CONFIG variable) and the collector answers on /<path>.
 */
const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);

createApp().listen(port, () => {
  process.stdout.write(`listening on http://localhost:${port}\n`);
});
