import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import type { Algo, CollectorConfig, HeaderValue, NonceStore } from './types.js';

/**
 * Verification order and responses (binding — identical to the PHP
 * collector's RequestVerifier):
 *  1. signature present + project_key match + algo match + valid signature → else 404
 *  2. expires_at passed / sleep mode                                       → 404
 *  3. time window ±10 min                                                  → 403 skew (+ server time)
 *  4. nonce replay / unwritable store                                      → 403 nonce | nonce-store
 *
 * No request value is ever used as a path, command or import target.
 */
export const SKEW_SECONDS = 600;

export const SLEEP_AFTER_SECONDS = 7_776_000; // 90 days

export const ALGOS: readonly Algo[] = ['ed25519', 'rsa-sha256'];

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410) ahead of the 32 raw bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface VerifyResult {
  status: 200 | 403 | 404;
  headers: Record<string, string>;
}

export function signatureMaterial(
  method: string,
  path: string,
  projectKey: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array,
): string {
  return `${method}\n${path}\n${projectKey}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Length-independent constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();

  return timingSafeEqual(left, right) && a.length === b.length;
}

export function normalizeHeaders(headers: Record<string, HeaderValue> | Headers): Record<string, string> {
  const out: Record<string, string> = {};

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });

    return out;
  }

  for (const [key, value] of Object.entries(headers as Record<string, HeaderValue>)) {
    if (value === undefined) {
      continue;
    }

    out[key.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : String(value);
  }

  return out;
}

function strictBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, '');

  if (compact === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return null;
  }

  return Buffer.from(compact, 'base64');
}

export function publicKeyObject(config: Pick<CollectorConfig, 'public_key' | 'algo'>): KeyObject | null {
  try {
    if (config.algo === 'ed25519') {
      const raw = strictBase64(config.public_key);

      if (raw === null || raw.length !== 32) {
        return null;
      }

      return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    }

    if (config.algo === 'rsa-sha256') {
      const key = createPublicKey({ key: config.public_key, format: 'pem' });

      return key.asymmetricKeyType === 'rsa' ? key : null;
    }
  } catch {
    return null;
  }

  return null;
}

export function signatureValid(
  config: Pick<CollectorConfig, 'public_key' | 'algo'>,
  material: string,
  signatureBase64: string,
): boolean {
  const signature = strictBase64(signatureBase64);

  if (signature === null) {
    return false;
  }

  const key = publicKeyObject(config);

  if (key === null) {
    return false;
  }

  try {
    if (config.algo === 'ed25519') {
      return signature.length === 64 && cryptoVerify(null, Buffer.from(material, 'utf8'), key, signature);
    }

    return cryptoVerify('sha256', Buffer.from(material, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export class RequestVerifier {
  constructor(
    private readonly config: CollectorConfig,
    private readonly nonceStore: NonceStore,
  ) {}

  async verify(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array,
    now: number,
  ): Promise<VerifyResult> {
    const signature = headers['x-sitetus-signature'] ?? '';
    const projectKey = headers['x-sitetus-key'] ?? '';
    const timestamp = headers['x-sitetus-timestamp'] ?? '';
    const nonce = headers['x-sitetus-nonce'] ?? '';
    const algo = headers['x-sitetus-algo'] ?? '';

    // 1. Signature gate — any failure is an anonymous 404.
    if (signature === '' || projectKey === '' || timestamp === '' || nonce === '') {
      return { status: 404, headers: {} };
    }

    if (!safeEqual(this.config.project_key, projectKey) || !safeEqual(this.config.algo, algo)) {
      return { status: 404, headers: {} };
    }

    const material = signatureMaterial(method, path, projectKey, timestamp, nonce, body);

    if (!signatureValid(this.config, material, signature)) {
      return { status: 404, headers: {} };
    }

    // 2. Lifecycle: expired package or sleep mode.
    const expiresAt = this.config.expires_at;

    if (typeof expiresAt === 'number' && now >= expiresAt) {
      return { status: 404, headers: {} };
    }

    const lastValid = await this.nonceStore.lastValidRequestAt();

    if (lastValid !== null && now - lastValid > SLEEP_AFTER_SECONDS) {
      return { status: 404, headers: {} };
    }

    // 3. Time window.
    const sent = Number.parseInt(timestamp, 10);

    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now - sent) > SKEW_SECONDS) {
      return { status: 403, headers: { 'X-Sitetus-Error': 'skew', 'X-Sitetus-Server-Time': String(now) } };
    }

    // 4. Nonce.
    const fresh = await this.nonceStore.register(nonce, now);

    if (fresh === null) {
      return { status: 403, headers: { 'X-Sitetus-Error': 'nonce-store' } };
    }

    if (fresh === false) {
      return { status: 403, headers: { 'X-Sitetus-Error': 'nonce' } };
    }

    return { status: 200, headers: {} };
  }
}
