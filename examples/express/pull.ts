import type { AddressInfo } from 'node:net';
import { MemoryNonceStore } from '../../src/nonce.js';
import type { Envelope } from '../../src/types.js';
import { configFor, ed25519Key, nowSeconds, signedHeaders, type TestKey } from '../../test/helpers.js';
import { createApp } from './app.js';

/**
 * Starts the example app on a free port and pulls it the way the panel
 * does: a freshly generated key pair, the five X-Sitetus-* headers over
 * `GET /<path>`, an empty body. Shared by the end-to-end test and the
 * fixture writer.
 */
export interface PullResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  envelope: Envelope | null;
}

export async function pullExampleApp(key: TestKey = ed25519Key()): Promise<PullResult> {
  const config = configFor(key, { project_key: 'exampleprojectkey001', path: 'sitetus-exampleexample01' });
  const app = createApp({ config, nonceStore: new MemoryNonceStore(), cwd: process.cwd() });
  const server = app.listen(0, '127.0.0.1');

  await new Promise<void>((resolve) => server.once('listening', resolve));

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/${config.path}/`, {
      headers: signedHeaders(key, config, { path: `/${config.path}/`, timestamp: nowSeconds() }),
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });

    return { status: response.status, headers, body, envelope: response.status === 200 ? (JSON.parse(body) as Envelope) : null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
