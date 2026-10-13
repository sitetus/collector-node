import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import type { NodeRequest } from '../src/adapters.js';
import type { Algo, CollectorConfig } from '../src/types.js';
import { signatureMaterial } from '../src/verify.js';

/** Test-side signer: what the panel does (CollectorRequestSigner) with a key generated here. */
export interface TestKey {
  algo: Algo;
  publicKey: string;
  privateKey: KeyObject;
}

export function ed25519Key(): TestKey {
  const pair = generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;

  return { algo: 'ed25519', publicKey: spki.subarray(spki.length - 32).toString('base64'), privateKey: pair.privateKey };
}

export function rsaKey(): TestKey {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return { algo: 'rsa-sha256', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }) as string, privateKey: pair.privateKey };
}

export function configFor(key: TestKey, overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    project_key: 'testprojectkey000001',
    public_key: key.publicKey,
    algo: key.algo,
    path: 'sitetus-testpath00000001',
    expires_at: null,
    modules: [],
    root_override: null,
    nonce_file: null,
    ...overrides,
  };
}

export function signMaterial(key: TestKey, material: string): string {
  const signature = key.algo === 'ed25519'
    ? sign(null, Buffer.from(material, 'utf8'), key.privateKey)
    : sign('sha256', Buffer.from(material, 'utf8'), key.privateKey);

  return signature.toString('base64');
}

export function signedHeaders(
  key: TestKey,
  config: CollectorConfig,
  options: { method?: string; path?: string; timestamp?: number; nonce?: string; body?: string } = {},
): Record<string, string> {
  const method = options.method ?? 'GET';
  const path = options.path ?? `/${config.path}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const body = Buffer.from(options.body ?? '', 'utf8');
  const material = signatureMaterial(method, path, config.project_key, timestamp, nonce, body);

  return {
    'x-sitetus-key': config.project_key,
    'x-sitetus-timestamp': timestamp,
    'x-sitetus-nonce': nonce,
    'x-sitetus-algo': key.algo,
    'x-sitetus-signature': signMaterial(key, material),
  };
}

/** Minimal Node response double: records status, headers and body as an adapter writes them. */
export function fakeResponse(): ServerResponse & { recorded: { status: number; headers: Record<string, string>; body: string; ended: boolean } } {
  const recorded = { status: 0, headers: { 'x-powered-by': 'Express' } as Record<string, string>, body: '', ended: false };
  const res = new EventEmitter() as ServerResponse & { recorded: typeof recorded };

  Object.assign(res, {
    recorded,
    headersSent: false,
    statusCode: 0,
    setHeader(name: string, value: string | number) {
      recorded.headers[name.toLowerCase()] = String(value);
    },
    removeHeader(name: string) {
      delete recorded.headers[name.toLowerCase()];
    },
    end(body?: string) {
      recorded.status = res.statusCode;
      recorded.body = body ?? '';
      recorded.ended = true;
      res.emit('finish');
    },
  });

  return res;
}

export function fakeRequest(url: string, headers: Record<string, string>, method = 'GET'): NodeRequest {
  return { method, url, originalUrl: url, headers } as unknown as NodeRequest;
}

export function finished(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => res.once('finish', resolve));
}

export interface ReadSpy {
  /** How many times the consumer asked the source for data. */
  reads: number;
  /** Bytes the source handed out. */
  bytes: number;
}

/**
 * A Node request whose body is a real stream that records every read:
 * `produce(n)` returns the n-th chunk, or null to end the body.
 */
export function streamRequest(
  url: string,
  headers: Record<string, string>,
  method: string,
  produce: (read: number) => Buffer | null,
): NodeRequest & { spy: ReadSpy } {
  const spy: ReadSpy = { reads: 0, bytes: 0 };
  const stream = new Readable({
    read() {
      spy.reads++;

      const chunk = produce(spy.reads);
      spy.bytes += chunk?.byteLength ?? 0;
      this.push(chunk);
    },
  });

  return Object.assign(stream, { method, url, originalUrl: url, headers, spy }) as unknown as NodeRequest & { spy: ReadSpy };
}

/** A web body stream that records every pull; nothing is produced until a reader asks. */
export function spiedWebBody(produce: (read: number) => Uint8Array | null): { stream: ReadableStream<Uint8Array>; spy: ReadSpy & { cancelled: boolean } } {
  const spy = { reads: 0, bytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        spy.reads++;

        const chunk = produce(spy.reads);

        if (chunk === null) {
          controller.close();

          return;
        }

        spy.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        spy.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return { stream, spy };
}

export function tempDir(prefix = 'sitetus-node-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
