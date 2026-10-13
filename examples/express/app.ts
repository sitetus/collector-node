import express from 'express';
// In your application: import { createCollector } from '@sitetus/collector';
import { createCollector, type CollectorOptions } from '../../src/index.js';

/**
 * The smallest Express app with the collector mounted. The collector only
 * answers on its own random path (`/<path>` from sitetus.collector.json);
 * every other request goes on to your routes.
 */
export function createApp(options: CollectorOptions = {}): express.Express {
  const app = express();
  const sitetusCollector = createCollector(options);

  app.disable('x-powered-by');
  app.use(sitetusCollector.express());

  app.get('/', (_request, response) => {
    response.type('text/plain').send('hello');
  });

  return app;
}
