import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { FastifyLikeReply, FastifyLikeRequest } from '../src/adapters.js';
import { ALLOWED_METHODS, MAX_BODY, readWebBody } from '../src/body.js';
import { createCollector, type SitetusCollector } from '../src/index.js';
import { MemoryNonceStore } from '../src/nonce.js';
import { configFor, ed25519Key, fakeRequest, fakeResponse, nowSeconds, removeDir, signedHeaders, spiedWebBody, streamRequest, tempDir, writeTree } from './helpers.js';

const key = ed25519Key();
const config = configFor(key);
const own = `/${config.path}`;
const root = tempDir();
writeTree(root, { 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) });

after(() => removeDir(root));

const CHUNK = 64 * 1024;
const chunk = Buffer.alloc(CHUNK, 0x61);
const exact = 'a'.repeat(MAX_BODY);
const oneOver = 'a'.repeat(MAX_BODY + 1);

function collectorAt(now: number): SitetusCollector {
  return createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });
}

/** Serves `text` in 64 KiB pieces, then ends. */
function pieces(text: string): (read: number) => Buffer | null {
  const body = Buffer.from(text, 'utf8');

  return (read) => {
    const start = (read - 1) * CHUNK;

    return start < body.byteLength ? body.subarray(start, start + CHUNK) : null;
  };
}

function webRequest(path: string, method: string, headers: Record<string, string>, body?: ReadableStream<Uint8Array>): Request {
  return new Request(`https://example.com${path}`, { method, headers, ...(body === undefined ? {} : { body, duplex: 'half' }) } as RequestInit);
}

describe('body policy constants', () => {
  it('caps the body at 1 MiB and serves GET, HEAD and POST only', () => {
    assert.equal(MAX_BODY, 1024 * 1024);
    assert.deepEqual([...ALLOWED_METHODS], ['GET', 'HEAD', 'POST']);
  });
});

describe('body policy: Node adapters (Express, Node http, Next.js Pages)', () => {
  it('refuses a Content-Length above the cap without reading', async () => {
    const now = nowSeconds();
    const req = streamRequest(own, { ...signedHeaders(key, config, { method: 'POST', timestamp: now }), 'content-length': String(MAX_BODY + 1) }, 'POST', () => chunk);
    const res = fakeResponse();

    assert.equal(await collectorAt(now).nodeHttp()(req, res), true);
    assert.equal(res.recorded.status, 404);
    assert.equal(res.recorded.body, '');
    assert.deepEqual(Object.keys(res.recorded.headers), []);
    assert.equal(req.spy.reads, 0);
  });

  it('stops reading a chunked body at the cap and answers the anonymous 404', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), 'transfer-encoding': 'chunked' };
    const req = streamRequest(own, headers, 'POST', () => chunk);
    const res = fakeResponse();

    await collectorAt(now).nextPagesHandler()(req, res);

    assert.equal(res.recorded.status, 404);
    assert.deepEqual(Object.keys(res.recorded.headers), []);
    assert.ok(req.spy.bytes > MAX_BODY, 'the cap was reached');
    assert.ok(req.spy.bytes <= MAX_BODY + 4 * CHUNK, `read ${req.spy.bytes} bytes of an endless body`);
  });

  it('refuses a correctly signed body that is one byte over the cap', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), 'transfer-encoding': 'chunked' };
    const res = fakeResponse();

    await collectorAt(now).nextPagesHandler()(streamRequest(own, headers, 'POST', pieces(oneOver)), res);

    assert.equal(res.recorded.status, 404);
  });

  it('accepts a signed body of exactly the cap', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: exact }), 'content-length': String(MAX_BODY) };
    const res = fakeResponse();

    await collectorAt(now).nextPagesHandler()(streamRequest(own, headers, 'POST', pieces(exact)), res);

    assert.equal(res.recorded.status, 200);
  });

  it('keeps the signature bound to the body that was read', async () => {
    const now = nowSeconds();
    const collector = collectorAt(now);
    const signedForOther = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: 'other' }), 'content-length': '5' };
    const tampered = fakeResponse();

    await collector.nextPagesHandler()(streamRequest(own, signedForOther, 'POST', pieces('hello')), tampered);
    assert.equal(tampered.recorded.status, 404);

    const signed = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: 'hello' }), 'content-length': '5' };
    const ok = fakeResponse();

    await collector.nextPagesHandler()(streamRequest(own, signed, 'POST', pieces('hello')), ok);
    assert.equal(ok.recorded.status, 200);
  });

  it('does not read the body of a request for another path', async () => {
    const collector = collectorAt(nowSeconds());
    const viaHttp = streamRequest('/upload', { 'content-length': '5' }, 'POST', pieces('hello'));

    assert.equal(await collector.nodeHttp()(viaHttp, fakeResponse()), false);
    assert.equal(viaHttp.spy.reads, 0);

    const viaExpress = streamRequest('/upload', { 'content-length': '5' }, 'POST', pieces('hello'));
    const res = fakeResponse();

    await new Promise<void>((resolve) => collector.express()(viaExpress, res, () => resolve()));
    assert.equal(res.recorded.ended, false);
    assert.equal(viaExpress.spy.reads, 0);

    const viaPages = streamRequest('/api/other', { 'content-length': '5' }, 'POST', pieces('hello'));
    const pages = fakeResponse();

    await collector.nextPagesHandler()(viaPages, pages);
    assert.equal(pages.recorded.status, 404);
    assert.equal(viaPages.spy.reads, 0);
  });

  it('does not read the body of a method the protocol does not use, even when it is signed', async () => {
    const now = nowSeconds();

    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const headers = { ...signedHeaders(key, config, { method, timestamp: now, body: 'hello' }), 'content-length': '5' };
      const req = streamRequest(own, headers, method, pieces('hello'));
      const res = fakeResponse();

      assert.equal(await collectorAt(now).nodeHttp()(req, res), true);
      assert.equal(res.recorded.status, 404, method);
      assert.deepEqual(Object.keys(res.recorded.headers), []);
      assert.equal(req.spy.reads, 0, method);
    }
  });

  it('serves the Pages Router mount under a prefix', async () => {
    const now = nowSeconds();
    const path = `/api/${config.path}`;
    const res = fakeResponse();

    await collectorAt(now).nextPagesHandler()(fakeRequest(path, signedHeaders(key, config, { path, timestamp: now })), res);
    assert.equal(res.recorded.status, 200);
  });

  it('answers 404 for a body the host already consumed, unless it kept the raw bytes', async () => {
    const now = nowSeconds();
    const collector = collectorAt(now);
    const headers = { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: 'hello' }), 'content-length': '5' };
    const consumed = fakeResponse();

    await collector.nextPagesHandler()(fakeRequest(own, headers, 'POST'), consumed);
    assert.equal(consumed.recorded.status, 404);

    const kept = fakeResponse();

    await collector.nextPagesHandler()(Object.assign(fakeRequest(own, headers, 'POST'), { rawBody: 'hello' }), kept);
    assert.equal(kept.recorded.status, 200);

    const tooLarge = fakeResponse();

    await collector.nextPagesHandler()(Object.assign(fakeRequest(own, signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), 'POST'), { rawBody: oneOver }), tooLarge);
    assert.equal(tooLarge.recorded.status, 404);
  });
});

describe('body policy: Node http over a real socket', () => {
  async function send(collector: SitetusCollector, headers: Record<string, string>, body: string): Promise<number> {
    const handler = collector.nodeHttp();
    const server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 204;
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { port } = server.address() as AddressInfo;

      return await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: own, method: 'POST', headers }, (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        });

        req.once('error', reject);
        req.end(body);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('accepts exactly the cap and refuses one byte more, chunked without Content-Length', async () => {
    const now = nowSeconds();
    const chunked = { 'transfer-encoding': 'chunked' };

    assert.equal(await send(collectorAt(now), { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: exact }), ...chunked }, exact), 200);
    assert.equal(await send(collectorAt(now), { ...signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), ...chunked }, oneOver), 404);
  });
});

describe('body policy: fetch and Next.js App Router adapters', () => {
  it('refuses a Content-Length above the cap without reading', async () => {
    const now = nowSeconds();
    const { stream, spy } = spiedWebBody(() => chunk);
    const headers = { ...signedHeaders(key, config, { method: 'POST', timestamp: now }), 'content-length': String(MAX_BODY + 1) };
    const response = await collectorAt(now).fetch()(webRequest(own, 'POST', headers, stream));

    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
    assert.equal(spy.reads, 0);
  });

  it('stops reading a body of unknown length at the cap and cancels it', async () => {
    const now = nowSeconds();
    const { stream, spy } = spiedWebBody(() => chunk);
    const response = await collectorAt(now).fetch()(webRequest(own, 'POST', signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), stream));

    assert.equal(response.status, 404);
    assert.equal([...response.headers.keys()].filter((name) => name.startsWith('x-sitetus')).length, 0);
    assert.ok(spy.bytes > MAX_BODY, 'the cap was reached');
    assert.ok(spy.bytes <= MAX_BODY + 2 * CHUNK, `read ${spy.bytes} bytes of an endless body`);
    assert.equal(spy.cancelled, true);
  });

  it('accepts a signed body of exactly the cap and refuses one byte more', async () => {
    const now = nowSeconds();
    const ok = await collectorAt(now).fetch()(webRequest(own, 'POST', signedHeaders(key, config, { method: 'POST', timestamp: now, body: exact }), spiedWebBody(pieces(exact)).stream));

    assert.equal(ok.status, 200);

    const over = await collectorAt(now).fetch()(webRequest(own, 'POST', signedHeaders(key, config, { method: 'POST', timestamp: now, body: oneOver }), spiedWebBody(pieces(oneOver)).stream));

    assert.equal(over.status, 404);
  });

  it('does not read the body of another path or of a method the protocol does not use', async () => {
    const now = nowSeconds();
    const foreign = spiedWebBody(pieces('hello'));

    assert.equal((await collectorAt(now).fetch()(webRequest('/upload', 'POST', {}, foreign.stream))).status, 404);
    assert.equal(foreign.spy.reads, 0);

    const put = spiedWebBody(pieces('hello'));
    const response = await collectorAt(now).fetch()(webRequest(own, 'PUT', signedHeaders(key, config, { method: 'PUT', timestamp: now, body: 'hello' }), put.stream));

    assert.equal(response.status, 404);
    assert.equal(put.spy.reads, 0);
  });

  it('answers 404 when the body was already consumed', async () => {
    const now = nowSeconds();
    const request = webRequest(own, 'POST', signedHeaders(key, config, { method: 'POST', timestamp: now, body: 'hello' }), spiedWebBody(pieces('hello')).stream);

    await request.text();

    assert.equal(await readWebBody(request), null);
    assert.equal((await collectorAt(now).fetch()(request)).status, 404);
  });
});

describe('body policy: fastify adapter', () => {
  async function call(collector: SitetusCollector, request: FastifyLikeRequest): Promise<number | undefined> {
    const routes = new Map<string, (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown>>();
    let status: number | undefined;
    const reply: FastifyLikeReply = {
      code(value: number) {
        status = value;

        return reply;
      },
      header: () => reply,
      send: () => undefined,
    };

    await collector.fastify()({ get: (url, handler) => routes.set(url, handler) });
    await routes.get(own)!(request, reply);

    return status;
  }

  it('refuses a Content-Length above the cap without reading the raw request', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { timestamp: now }), 'content-length': String(MAX_BODY + 1) };
    const raw = streamRequest(own, headers, 'GET', () => chunk);

    assert.equal(await call(collectorAt(now), { method: 'GET', url: own, headers, raw }), 404);
    assert.equal(raw.spy.reads, 0);
  });

  it('reads the raw request up to the cap and no further', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { timestamp: now, body: oneOver }), 'transfer-encoding': 'chunked' };
    const raw = streamRequest(own, headers, 'GET', () => chunk);

    assert.equal(await call(collectorAt(now), { method: 'GET', url: own, headers, raw }), 404);
    assert.ok(raw.spy.bytes <= MAX_BODY + 4 * CHUNK, `read ${raw.spy.bytes} bytes of an endless body`);
  });

  it('accepts a signed body of exactly the cap, and 404s a declared body it cannot see', async () => {
    const now = nowSeconds();
    const headers = { ...signedHeaders(key, config, { timestamp: now, body: exact }), 'content-length': String(MAX_BODY) };

    assert.equal(await call(collectorAt(now), { method: 'GET', url: own, headers, raw: streamRequest(own, headers, 'GET', pieces(exact)) }), 200);
    assert.equal(await call(collectorAt(now), { method: 'GET', url: own, headers }), 404);
  });
});
