import type { IncomingMessage } from 'node:http';
import type { CollectorRequest, CollectorResponse } from './types.js';

/**
 * Request-body policy, shared by every adapter (same figures as the PHP and
 * Python collectors):
 *
 *  1. path and method are decided first — a request for another path, or
 *     with a method the protocol does not use, is answered without touching
 *     its body;
 *  2. a `Content-Length` above the cap is refused without reading;
 *  3. a body of unknown length is read up to the cap and no further;
 *  4. anything over the cap, cut short or already consumed by the host
 *     framework is the same anonymous 404 as an unknown route — the
 *     signature is never checked against a body that was not read in full.
 */
export const MAX_BODY = 1024 * 1024;

/** The panel pulls with GET and an empty body; HEAD and POST are verified the same way, nothing else is served. */
export const ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD', 'POST'];

const EMPTY = new Uint8Array(0);

export type RequestHead = Pick<CollectorRequest, 'method' | 'path' | 'headers'>;

/** Reads the body with at most `limit` bytes kept; null = over the limit, cut short or unreadable. */
export type BodyReader = (limit: number) => Uint8Array | null | Promise<Uint8Array | null>;

export interface BodyGate {
  admits(head: RequestHead): Promise<boolean>;
  handle(request: CollectorRequest): Promise<CollectorResponse>;
}

export type NodeBodyRequest = IncomingMessage & { rawBody?: string | Uint8Array | undefined };

export function notFound(): CollectorResponse {
  return { status: 404, headers: {}, body: null };
}

export function methodAllowed(method: string): boolean {
  return ALLOWED_METHODS.includes(method.toUpperCase());
}

/** `Content-Length` as a byte count; null when absent, false when it is not a plain number. */
export function declaredLength(headers: Record<string, string>): number | null | false {
  const value = headers['content-length'];

  if (value === undefined || value.trim() === '') {
    return null;
  }

  return /^\d{1,15}$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : false;
}

/** True when the headers announce a body: a non-zero `Content-Length` or any `Transfer-Encoding`. */
export function bodyDeclared(headers: Record<string, string>): boolean {
  const length = declaredLength(headers);

  return (headers['transfer-encoding'] ?? '') !== '' || (length !== null && length !== 0);
}

/**
 * The one entry point adapters use: gate first (method, path,
 * `Content-Length`), then the capped read, then verification.
 */
export async function serveRequest(collector: BodyGate, head: RequestHead, readBody: BodyReader): Promise<CollectorResponse> {
  if (!(await collector.admits(head))) {
    return notFound();
  }

  const body = await readBody(MAX_BODY);

  if (body === null || body.byteLength > MAX_BODY) {
    return notFound();
  }

  return collector.handle({ ...head, body });
}

/**
 * Node stream. A `rawBody` captured by the host (body-parser `verify` hook)
 * is used as is; a stream the host already consumed cannot be verified, so
 * it is only accepted when the headers announce no body.
 */
export function readNodeBody(req: NodeBodyRequest, headers: Record<string, string>, limit: number = MAX_BODY): Promise<Uint8Array | null> {
  if (req.rawBody !== undefined) {
    const raw = typeof req.rawBody === 'string' ? Buffer.from(req.rawBody, 'utf8') : req.rawBody;

    return Promise.resolve(raw.byteLength > limit ? null : raw);
  }

  if (typeof req.on !== 'function' || req.readableEnded === true || req.destroyed === true) {
    return Promise.resolve(bodyDeclared(headers) ? null : EMPTY);
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const finish = (result: Uint8Array | null): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onFail);
      req.removeListener('close', onFail);
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += piece.byteLength;

      if (total > limit) {
        req.pause();
        finish(null);

        return;
      }

      chunks.push(piece);
    };

    const onEnd = (): void => finish(Buffer.concat(chunks, total));
    const onFail = (): void => finish(null);

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFail);
    req.once('close', onFail);
  });
}

/** Web `Request`: the stream is read chunk by chunk and cancelled at the cap — never `arrayBuffer()`. */
export async function readWebBody(request: Request, limit: number = MAX_BODY): Promise<Uint8Array | null> {
  const stream = request.body;

  if (stream === null || stream === undefined) {
    return request.bodyUsed ? null : EMPTY;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    const reader = stream.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.byteLength;

      if (total > limit) {
        await reader.cancel().catch(() => undefined);

        return null;
      }

      chunks.push(value);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks, total);
}
