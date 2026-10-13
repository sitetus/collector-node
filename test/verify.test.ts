import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryNonceStore } from '../src/nonce.js';
import type { NonceStore } from '../src/types.js';
import { RequestVerifier, SKEW_SECONDS, SLEEP_AFTER_SECONDS, safeEqual, signatureMaterial, signatureValid } from '../src/verify.js';
import { configFor, ed25519Key, nowSeconds, rsaKey, signedHeaders, type TestKey } from './helpers.js';

/** The PHP collector's shared vector (tests/fixtures/signature-vector.json): the material and the Ed25519 signature must match byte for byte. */
const vector = JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'signature-vector.json'), 'utf8')) as Record<string, string>;

function verifierFor(key: TestKey, overrides = {}, store: NonceStore = new MemoryNonceStore()) {
  const config = configFor(key, overrides);

  return { config, verifier: new RequestVerifier(config, store), store };
}

describe('signature material', () => {
  it('matches the PHP collector vector', () => {
    const material = signatureMaterial(vector['method']!, vector['path']!, vector['project_key']!, vector['timestamp']!, vector['nonce']!, Buffer.from(vector['body']!));

    assert.equal(createHash('sha256').update(material).digest('hex'), vector['material_sha256']);
    assert.equal(signatureValid({ algo: 'ed25519', public_key: vector['public_key_b64']! }, material, vector['signature_b64']!), true);
  });

  it('includes the body hash', () => {
    const empty = signatureMaterial('GET', '/x', 'k', '1', 'n', new Uint8Array(0));
    const withBody = signatureMaterial('GET', '/x', 'k', '1', 'n', Buffer.from('a'));

    assert.notEqual(empty, withBody);
    assert.ok(empty.endsWith('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'));
  });

  it('compares strings in constant time without leaking equality on length', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
  });
});

for (const [label, make] of [
  ['ed25519', ed25519Key],
  ['rsa-sha256', rsaKey],
] as const) {
  describe(`verification matrix (${label})`, () => {
    const key = make();

    it('accepts a correctly signed request', async () => {
      const { config, verifier } = verifierFor(key);
      const now = nowSeconds();
      const result = await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp: now }), new Uint8Array(0), now);

      assert.deepEqual(result, { status: 200, headers: {} });
    });

    it('answers an unsigned request with an anonymous 404', async () => {
      const { config, verifier } = verifierFor(key);

      assert.deepEqual(await verifier.verify('GET', `/${config.path}`, {}, new Uint8Array(0), nowSeconds()), { status: 404, headers: {} });
    });

    it('answers a wrong project key with 404', async () => {
      const { config, verifier } = verifierFor(key);
      const headers = signedHeaders(key, config);
      headers['x-sitetus-key'] = 'otherprojectkey00001';

      assert.equal((await verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), nowSeconds())).status, 404);
    });

    it('answers a wrong algo header with 404', async () => {
      const { config, verifier } = verifierFor(key);
      const headers = signedHeaders(key, config);
      headers['x-sitetus-algo'] = key.algo === 'ed25519' ? 'rsa-sha256' : 'ed25519';

      assert.equal((await verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), nowSeconds())).status, 404);
    });

    it('answers a tampered signature, path, method or body with 404', async () => {
      const { config, verifier } = verifierFor(key);
      const now = nowSeconds();
      const headers = signedHeaders(key, config, { timestamp: now });

      assert.equal((await verifier.verify('GET', `/${config.path}/other`, headers, new Uint8Array(0), now)).status, 404);
      assert.equal((await verifier.verify('POST', `/${config.path}`, headers, new Uint8Array(0), now)).status, 404);
      assert.equal((await verifier.verify('GET', `/${config.path}`, headers, Buffer.from('x'), now)).status, 404);

      const broken = { ...headers, 'x-sitetus-signature': 'AAAA' };
      assert.equal((await verifier.verify('GET', `/${config.path}`, broken, new Uint8Array(0), now)).status, 404);

      const notBase64 = { ...headers, 'x-sitetus-signature': '!!' };
      assert.equal((await verifier.verify('GET', `/${config.path}`, notBase64, new Uint8Array(0), now)).status, 404);
    });

    it('answers a request signed by another key with 404', async () => {
      const { config, verifier } = verifierFor(key);
      const other = make();
      const headers = signedHeaders(other, { ...config, public_key: other.publicKey });

      assert.equal((await verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), nowSeconds())).status, 404);
    });

    it('answers 404 after expires_at even when the signature is valid', async () => {
      const now = nowSeconds();
      const { config, verifier } = verifierFor(key, { expires_at: now - 1 });

      assert.equal((await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp: now }), new Uint8Array(0), now)).status, 404);
    });

    it('still answers right before expires_at', async () => {
      const now = nowSeconds();
      const { config, verifier } = verifierFor(key, { expires_at: now + 1 });

      assert.equal((await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp: now }), new Uint8Array(0), now)).status, 200);
    });

    it('sleeps (404) when the last valid request is older than 90 days', async () => {
      const now = nowSeconds();
      const store = new MemoryNonceStore();
      const sleeping = { register: (nonce: string, at: number) => store.register(nonce, at), lastValidRequestAt: () => now - SLEEP_AFTER_SECONDS - 1 };
      const { config, verifier } = verifierFor(key, {}, sleeping);

      assert.equal((await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp: now }), new Uint8Array(0), now)).status, 404);
    });

    it('answers skew with 403, the error header and the server time', async () => {
      const { config, verifier } = verifierFor(key);
      const now = nowSeconds();

      for (const timestamp of [now - SKEW_SECONDS - 1, now + SKEW_SECONDS + 1]) {
        const result = await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp }), new Uint8Array(0), now);

        assert.deepEqual(result, { status: 403, headers: { 'X-Sitetus-Error': 'skew', 'X-Sitetus-Server-Time': String(now) } });
      }

      assert.equal((await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config, { timestamp: now - SKEW_SECONDS }), new Uint8Array(0), now)).status, 200);
    });

    it('answers a replayed nonce with 403 nonce', async () => {
      const { config, verifier } = verifierFor(key);
      const now = nowSeconds();
      const headers = signedHeaders(key, config, { timestamp: now });

      assert.equal((await verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), now)).status, 200);
      assert.deepEqual(await verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), now + 1), { status: 403, headers: { 'X-Sitetus-Error': 'nonce' } });
    });

    it('answers 403 nonce-store when the store cannot be written', async () => {
      const { config, verifier } = verifierFor(key, {}, { register: () => null, lastValidRequestAt: () => null });

      assert.deepEqual(await verifier.verify('GET', `/${config.path}`, signedHeaders(key, config), new Uint8Array(0), nowSeconds()), {
        status: 403,
        headers: { 'X-Sitetus-Error': 'nonce-store' },
      });
    });

    it('runs the gates in spec order: signature before expiry, expiry before skew, skew before nonce', async () => {
      const now = nowSeconds();
      const store = new MemoryNonceStore();
      const { config, verifier } = verifierFor(key, { expires_at: now - 1 }, store);
      const skewed = signedHeaders(key, config, { timestamp: now - SKEW_SECONDS * 2 });

      // Expired AND skewed → 404 (expiry wins over skew).
      assert.equal((await verifier.verify('GET', `/${config.path}`, skewed, new Uint8Array(0), now)).status, 404);

      const live = verifierFor(key, {}, store);
      const headers = signedHeaders(key, live.config, { timestamp: now });
      assert.equal((await live.verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), now)).status, 200);

      // Replayed AND skewed → skew (skew is checked before the nonce).
      const replayedLater = await live.verifier.verify('GET', `/${config.path}`, headers, new Uint8Array(0), now + SKEW_SECONDS + 1);
      assert.equal(replayedLater.headers['X-Sitetus-Error'], 'skew');
    });
  });
}

describe('public key handling', () => {
  it('rejects malformed keys instead of throwing', () => {
    const material = signatureMaterial('GET', '/x', 'k', '1', 'n', new Uint8Array(0));

    assert.equal(signatureValid({ algo: 'ed25519', public_key: 'not-base64!' }, material, 'AAAA'), false);
    assert.equal(signatureValid({ algo: 'ed25519', public_key: Buffer.alloc(31).toString('base64') }, material, 'AAAA'), false);
    assert.equal(signatureValid({ algo: 'rsa-sha256', public_key: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----' }, material, 'AAAA'), false);
    assert.equal(signatureValid({ algo: 'rsa-sha256', public_key: ed25519Key().publicKey }, material, 'AAAA'), false);
  });
});
