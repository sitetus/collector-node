import type { IncomingMessage, ServerResponse } from 'node:http';
import { bodyDeclared, notFound, readNodeBody, readWebBody, serveRequest } from './body.js';
import type { Collector } from './collector.js';
import type { CollectorResponse, HeaderValue } from './types.js';
import { normalizeHeaders } from './verify.js';

/**
 * Transport adapters. Each one maps the framework's request onto
 * `serveRequest()` and writes the result back verbatim: status, the
 * X-Sitetus-* headers on 403, the JSON body on 200 and nothing at all on
 * 404 — no body, no `Server`/`X-Powered-By` header.
 *
 * The panel signs the URL path only (no query string) and sends an empty
 * body. Every adapter follows the one body policy in `body.ts`: method and
 * path are decided before a byte is read, the read stops at `MAX_BODY`, and
 * a body the framework already consumed is not re-read — the signature
 * covers the raw bytes, so such a request is a 404 unless the host kept
 * them in `rawBody`.
 */
export type NodeRequest = IncomingMessage & { originalUrl?: string | undefined; rawBody?: string | Uint8Array | undefined };

export function pathOf(url: string | undefined): string {
  const raw = url ?? '/';
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);

  return path === '' ? '/' : path;
}

export function writeNodeResponse(res: ServerResponse, result: CollectorResponse): void {
  res.statusCode = result.status;
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  for (const [name, value] of Object.entries(result.headers)) {
    res.setHeader(name, value);
  }

  if (result.body === null) {
    res.end();

    return;
  }

  res.setHeader('Content-Length', Buffer.byteLength(result.body, 'utf8'));
  res.end(result.body);
}

export async function handleNodeRequest(collector: Collector, req: NodeRequest, res: ServerResponse): Promise<void> {
  const headers = normalizeHeaders(req.headers as Record<string, HeaderValue>);
  const head = { method: req.method ?? 'GET', path: pathOf(req.originalUrl ?? req.url), headers };
  const result = await serveRequest(collector, head, (limit) => readNodeBody(req, headers, limit));

  writeNodeResponse(res, result);
}

/** Node `http.createServer` handler; resolves to false when the path is not the collector's. */
export function nodeHttp(collector: Collector): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    if (!(await collector.matches(pathOf((req as NodeRequest).originalUrl ?? req.url)))) {
      return false;
    }

    await handleNodeRequest(collector, req as NodeRequest, res);

    return true;
  };
}

/** Express / Connect middleware: `app.use(collector.express())` — answers only on its own path. */
export function express(collector: Collector): (req: NodeRequest, res: ServerResponse, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    void (async () => {
      if (!(await collector.matches(pathOf(req.originalUrl ?? req.url)))) {
        next();

        return;
      }

      await handleNodeRequest(collector, req, res);
    })().catch((error: unknown) => {
      if (res.headersSent) {
        next(error);

        return;
      }

      writeNodeResponse(res, notFound());
    });
  };
}

/** Web standard `Request → Response`; the base for Next.js App Router, Hono, Remix, SvelteKit, edge functions. */
export function fetchHandler(collector: Collector): (request: Request) => Promise<Response> {
  return async (request) => {
    let path = '/';

    try {
      path = new URL(request.url).pathname;
    } catch {
      path = pathOf(request.url);
    }

    const head = { method: request.method, path, headers: normalizeHeaders(request.headers) };
    const result = await serveRequest(collector, head, (limit) => readWebBody(request, limit));

    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}

/** Next.js App Router: `export const { GET } = collector.nextRouteHandler()` in `app/<path>/route.ts`. */
export function nextRouteHandler(collector: Collector): { GET: (request: Request) => Promise<Response>; dynamic: 'force-dynamic' } {
  return { GET: fetchHandler(collector), dynamic: 'force-dynamic' };
}

/** Next.js Pages Router: `export default collector.nextPagesHandler()` in `pages/api/<path>.ts`. */
export function nextPagesHandler(collector: Collector): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return (req, res) => handleNodeRequest(collector, req as NodeRequest, res);
}

export interface FastifyLikeReply {
  code(status: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  removeHeader?(name: string): unknown;
  send(body?: string): unknown;
}

export interface FastifyLikeRequest {
  method: string;
  url: string;
  headers: Record<string, HeaderValue>;
  body?: unknown;
  /** The underlying Node request; its stream is read (capped) when Fastify left it untouched. */
  raw?: IncomingMessage;
}

export interface FastifyLikeInstance {
  get(url: string, handler: (request: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<unknown>): unknown;
}

/** Fastify plugin: `await app.register(collector.fastify())`. */
export function fastify(collector: Collector): (instance: FastifyLikeInstance) => Promise<void> {
  return async (instance) => {
    const path = await collector.mountPath();
    const handler = async (request: FastifyLikeRequest, reply: FastifyLikeReply): Promise<unknown> => {
      const headers = normalizeHeaders(request.headers);
      const head = { method: request.method, path: pathOf(request.url), headers };
      const result = await serveRequest(collector, head, (limit) => {
        if (request.raw !== undefined) {
          return readNodeBody(request.raw as NodeRequest, headers, limit);
        }

        return bodyDeclared(headers) ? null : new Uint8Array(0);
      });

      reply.code(result.status);
      reply.removeHeader?.('X-Powered-By');

      for (const [name, value] of Object.entries(result.headers)) {
        reply.header(name, value);
      }

      if (result.body !== null) {
        reply.header('Content-Type', 'application/json');
      }

      return reply.send(result.body ?? undefined);
    };

    instance.get(path, handler);
    instance.get(`${path}/`, handler);
  };
}
