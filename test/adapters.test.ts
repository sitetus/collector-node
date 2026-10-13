import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { express, pathOf, type FastifyLikeReply, type FastifyLikeRequest } from '../src/adapters.js';
import type { Collector } from '../src/collector.js';
import { createCollector } from '../src/index.js';
import { MemoryNonceStore } from '../src/nonce.js';
import { configFor, ed25519Key, fakeRequest, fakeResponse, finished, nowSeconds, removeDir, signedHeaders, tempDir, writeTree } from './helpers.js';
import { validateEnvelope } from './schema.js';

const key = ed25519Key();
const config = configFor(key);
const root = tempDir();
writeTree(root, { 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) });

after(() => removeDir(root));

describe('pathOf', () => {
  it('strips query and fragment and never returns an empty path', () => {
    assert.equal(pathOf('/a/b?x=1'), '/a/b');
    assert.equal(pathOf('/a#x'), '/a');
    assert.equal(pathOf(''), '/');
    assert.equal(pathOf(undefined), '/');
  });
});

describe('express adapter', () => {
  it('serves the envelope on its own path and strips X-Powered-By', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const res = fakeResponse();
    const done = finished(res);

    collector.express()(fakeRequest(`/${config.path}/`, signedHeaders(key, config, { path: `/${config.path}/`, timestamp: now })), res, () => assert.fail('next() must not be called'));
    await done;

    assert.equal(res.recorded.status, 200);
    assert.equal(res.recorded.headers['content-type'], 'application/json');
    assert.equal(res.recorded.headers['x-powered-by'], undefined);
    assert.deepEqual(validateEnvelope(JSON.parse(res.recorded.body)), []);
  });

  it('passes other paths to next()', async () => {
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore() });
    const res = fakeResponse();

    await new Promise<void>((resolve) => collector.express()(fakeRequest('/healthz', {}), res, () => resolve()));
    assert.equal(res.recorded.ended, false);
  });

  it('writes a bodyless 404 for an unsigned request on its path', async () => {
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore() });
    const res = fakeResponse();
    const done = finished(res);

    collector.express()(fakeRequest(`/${config.path}?probe=1`, {}), res, () => assert.fail('next() must not be called'));
    await done;

    assert.equal(res.recorded.status, 404);
    assert.equal(res.recorded.body, '');
    assert.deepEqual(Object.keys(res.recorded.headers), []);
  });

  it('writes the skew headers on 403', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const res = fakeResponse();
    const done = finished(res);

    collector.express()(fakeRequest(`/${config.path}`, signedHeaders(key, config, { timestamp: now - 10_000 })), res, () => undefined);
    await done;

    assert.equal(res.recorded.status, 403);
    assert.equal(res.recorded.headers['x-sitetus-error'], 'skew');
    assert.equal(res.recorded.headers['x-sitetus-server-time'], String(now));
    assert.equal(res.recorded.body, '');
  });

  describe('when handling fails', () => {
    const failure = new Error('boom');
    const failing = {
      matches: async () => true,
      admits: async () => true,
      handle: async () => {
        throw failure;
      },
    } as unknown as Collector;

    it('answers a bodyless 404 while the response has not started', async () => {
      const res = fakeResponse();
      const done = finished(res);

      express(failing)(fakeRequest('/any', {}), res, () => assert.fail('next() must not be called'));
      await done;

      assert.equal(res.recorded.status, 404);
      assert.equal(res.recorded.body, '');
    });

    it('hands the error to next() once the headers were sent', async () => {
      const res = fakeResponse();
      Object.assign(res, { headersSent: true });

      const passed = await new Promise<unknown>((resolve) => express(failing)(fakeRequest('/any', {}), res, resolve));

      assert.equal(passed, failure);
      assert.equal(res.recorded.ended, false);
    });
  });
});

describe('node http and Next.js Pages adapters', () => {
  it('nodeHttp reports whether it handled the request', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const handler = collector.nodeHttp();

    assert.equal(await handler(fakeRequest('/other', {}), fakeResponse()), false);

    const res = fakeResponse();
    assert.equal(await handler(fakeRequest(`/${config.path}`, signedHeaders(key, config, { timestamp: now })), res), true);
    assert.equal(res.recorded.status, 200);
  });

  it('nextPagesHandler answers like the node handler', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const res = fakeResponse();

    await collector.nextPagesHandler()(fakeRequest(`/${config.path}`, signedHeaders(key, config, { timestamp: now })), res);
    assert.equal(res.recorded.status, 200);
    assert.deepEqual(validateEnvelope(JSON.parse(res.recorded.body)), []);
  });
});

describe('fetch and Next.js App Router adapters', () => {
  it('maps a web Request to a Response with the same status, headers and body rules', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const { GET, dynamic } = collector.nextRouteHandler();

    assert.equal(dynamic, 'force-dynamic');

    const ok = await GET(new Request(`https://example.com/${config.path}?x=1`, { headers: signedHeaders(key, config, { timestamp: now }) }));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/json');
    assert.deepEqual(validateEnvelope(await ok.json()), []);

    const anonymous = await GET(new Request(`https://example.com/${config.path}`));
    assert.equal(anonymous.status, 404);
    assert.equal(await anonymous.text(), '');
    assert.equal(anonymous.headers.get('x-sitetus-error'), null);

    const replay = await collector.fetch()(new Request(`https://example.com/${config.path}`, { headers: signedHeaders(key, config, { timestamp: now }) }));
    assert.equal(replay.status, 200);
  });
});

describe('fastify adapter', () => {
  it('registers both path forms and writes the result through the reply', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
    const routes = new Map<string, (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown>>();

    await collector.fastify()({ get: (url, handler) => routes.set(url, handler) });

    assert.deepEqual([...routes.keys()], [`/${config.path}`, `/${config.path}/`]);

    const sent: { status?: number; headers: Record<string, string>; body: string | undefined } = { headers: {}, body: undefined };
    const reply: FastifyLikeReply = {
      code(status: number) {
        sent.status = status;

        return reply;
      },
      header(name: string, value: string) {
        sent.headers[name.toLowerCase()] = value;

        return reply;
      },
      send(body?: string) {
        sent.body = body;
      },
    };

    await routes.get(`/${config.path}`)!({ method: 'GET', url: `/${config.path}`, headers: signedHeaders(key, config, { timestamp: now }) }, reply);

    assert.equal(sent.status, 200);
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.deepEqual(validateEnvelope(JSON.parse(sent.body ?? 'null')), []);
  });
});
