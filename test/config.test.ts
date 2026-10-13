import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CONFIG_ENV, configFromPairing, decodePairingCode, loadConfig, normalizeConfig } from '../src/config.js';
import { ed25519Key, removeDir, rsaKey, tempDir } from './helpers.js';

/** Exactly what the panel's CollectorPairingCode::encode() produces (base64url JSON, no padding). */
function encode(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const key = ed25519Key();

const panelPayload = {
  v: 1,
  project_key: 'abcdefghijklmnopqrst',
  public_key: key.publicKey,
  algo: 'ed25519',
  expires_at: 1790000000,
  nonce_file: '.sitetus-abc123def456.json',
  modules: ['files', 'archives', 'permissions'],
  site: 'example.com',
  panel: 'https://panel.example.com',
};

describe('decodePairingCode', () => {
  it('decodes the panel payload the WordPress plugin decodes', () => {
    const decoded = decodePairingCode(encode(panelPayload));

    assert.deepEqual(decoded, {
      project_key: 'abcdefghijklmnopqrst',
      public_key: key.publicKey,
      algo: 'ed25519',
      expires_at: 1790000000,
      nonce_file: '.sitetus-abc123def456.json',
      modules: ['files', 'archives', 'permissions'],
      path: null,
      panel: 'https://panel.example.com',
      site: 'example.com',
    });
  });

  it('accepts the optional path field (install_path alias) for Node installs', () => {
    assert.equal(decodePairingCode(encode({ ...panelPayload, path: 'sitetus-abcdefghijklmnop' }))?.path, 'sitetus-abcdefghijklmnop');
    assert.equal(decodePairingCode(encode({ ...panelPayload, install_path: 'sitetus-abcdefghijklmnop' }))?.path, 'sitetus-abcdefghijklmnop');
    assert.equal(decodePairingCode(encode({ ...panelPayload, path: '../etc' })), null);
  });

  it('tolerates a missing nonce_file and a null expiry', () => {
    const { nonce_file: _omitted, ...withoutNonce } = panelPayload;
    const decoded = decodePairingCode(encode({ ...withoutNonce, expires_at: null }));

    assert.equal(decoded?.nonce_file, null);
    assert.equal(decoded?.expires_at, null);
  });

  it('rejects anything that is not a version-1 pairing code', () => {
    assert.equal(decodePairingCode(''), null);
    assert.equal(decodePairingCode('not base64url!'), null);
    assert.equal(decodePairingCode(Buffer.from('[]').toString('base64url')), null);
    assert.equal(decodePairingCode(encode({ ...panelPayload, v: 2 })), null);
    assert.equal(decodePairingCode(encode({ ...panelPayload, project_key: 'UPPER' })), null);
    assert.equal(decodePairingCode(encode({ ...panelPayload, algo: 'hmac' })), null);
    assert.equal(decodePairingCode(encode({ ...panelPayload, public_key: '' })), null);
    assert.equal(decodePairingCode(encode({ ...panelPayload, nonce_file: 'evil.php' })), null);
  });

  it('drops unknown modules and unsafe panel URLs', () => {
    const decoded = decodePairingCode(encode({ ...panelPayload, modules: ['files', 'Rm -rf', 7], panel: 'javascript:alert(1)' }));

    assert.deepEqual(decoded?.modules, ['files']);
    assert.equal(decoded?.panel, '');
  });
});

describe('configuration', () => {
  const dir = tempDir();

  after(() => {
    removeDir(dir);
    delete process.env[CONFIG_ENV];
  });

  it('builds a secret-free config from a pairing payload', () => {
    const config = configFromPairing(decodePairingCode(encode(panelPayload))!, 'sitetus-abcdefghijklmnop');

    assert.equal(config.path, 'sitetus-abcdefghijklmnop');
    assert.equal(config.public_key, key.publicKey);
    assert.equal(config.nonce_file, '.sitetus-abc123def456.json');
    assert.ok(!JSON.stringify(config).includes('private'));
  });

  it('rejects a config without a usable path or key', () => {
    assert.throws(() => normalizeConfig({ project_key: 'abcdefghij', public_key: 'x', algo: 'ed25519' }), /path/);
    assert.throws(() => normalizeConfig({ project_key: 'abcdefghij', public_key: 'x', algo: 'none', path: 'sitetus-abcd' }), /algo/);
    assert.throws(() => normalizeConfig(null), /object/);
  });

  describe('one validation for the pairing code and a hand-written configuration', () => {
    const manual = { project_key: 'abcdefghijklmnopqrst', public_key: key.publicKey, algo: 'ed25519', path: 'sitetus-abcdefghijklmnop' };
    const rsa = rsaKey();

    it('accepts the same well-formed values on both paths', () => {
      assert.equal(normalizeConfig({ ...manual, nonce_file: '.sitetus-abc123def456.json' }).nonce_file, '.sitetus-abc123def456.json');
      assert.equal(normalizeConfig({ ...manual, public_key: rsa.publicKey, algo: 'rsa-sha256' }).algo, 'rsa-sha256');
      assert.equal(decodePairingCode(encode({ ...panelPayload, public_key: rsa.publicKey, algo: 'rsa-sha256' }))?.algo, 'rsa-sha256');
    });

    for (const nonceFile of ['../.sitetus-abc123def456.json', '/tmp/.sitetus-abc123def456.json', 'dir/.sitetus-abc123def456.json', 'dir\\.sitetus-abc123def456.json', '.sitetus-abc123def456.json/..', 'evil.php', '', 7]) {
      it(`rejects nonce_file ${JSON.stringify(nonceFile)} on both paths`, () => {
        assert.throws(() => normalizeConfig({ ...manual, nonce_file: nonceFile }), /nonce_file/);
        assert.equal(decodePairingCode(encode({ ...panelPayload, nonce_file: nonceFile })), null);
      });
    }

    for (const [label, broken] of [
      ['an Ed25519 key that is not base64', { public_key: 'not base64!' }],
      ['an Ed25519 key of the wrong length', { public_key: Buffer.alloc(31).toString('base64') }],
      ['a PEM where a raw Ed25519 key is expected', { public_key: rsa.publicKey }],
      ['a raw key where an RSA PEM is expected', { algo: 'rsa-sha256' }],
      ['a broken RSA PEM', { algo: 'rsa-sha256', public_key: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' }],
      ['a key above 4096 characters', { public_key: 'A'.repeat(4097) }],
    ] as const) {
      it(`rejects ${label} on both paths`, () => {
        assert.throws(() => normalizeConfig({ ...manual, ...broken }), /public_key/);
        assert.equal(decodePairingCode(encode({ ...panelPayload, ...broken })), null);
      });
    }

    it('rejects a malformed project key, algorithm and path on both paths', () => {
      assert.throws(() => normalizeConfig({ ...manual, project_key: 'Bad Key' }), /project_key/);
      assert.throws(() => normalizeConfig({ ...manual, algo: 'hmac' }), /algo/);
      assert.throws(() => normalizeConfig({ ...manual, path: '../etc' }), /path/);
      assert.throws(() => normalizeConfig({ ...manual, path: 'a/b/c/d' }), /path/);
      assert.equal(decodePairingCode(encode({ ...panelPayload, project_key: 'Bad Key' })), null);
      assert.equal(decodePairingCode(encode({ ...panelPayload, algo: 'hmac' })), null);
      assert.equal(decodePairingCode(encode({ ...panelPayload, path: 'a/b/c/d' })), null);
    });

    it('keeps only allow-listed module names on both paths', () => {
      assert.deepEqual(normalizeConfig({ ...manual, modules: ['files', 'Rm -rf', '../x', 7] }).modules, ['files']);
      assert.deepEqual(decodePairingCode(encode({ ...panelPayload, modules: ['files', 'Rm -rf', '../x', 7] }))?.modules, ['files']);
    });
  });

  it('loads from the environment variable before the file', async () => {
    process.env[CONFIG_ENV] = JSON.stringify({ project_key: 'envprojectkey0000001', public_key: key.publicKey, algo: 'ed25519', path: 'sitetus-fromenv0000000' });

    const config = await loadConfig();
    assert.equal(config.project_key, 'envprojectkey0000001');

    delete process.env[CONFIG_ENV];
  });

  it('loads from an explicit file path', async () => {
    const file = join(dir, 'sitetus.collector.json');
    writeFileSync(file, JSON.stringify({ project_key: 'fileprojectkey000001', public_key: key.publicKey, algo: 'ed25519', path: 'sitetus-fromfile000000', expires_at: 123 }));

    const config = await loadConfig(file);
    assert.equal(config.project_key, 'fileprojectkey000001');
    assert.equal(config.expires_at, 123);
  });

  it('explains a missing configuration', async () => {
    await assert.rejects(loadConfig(join(dir, 'nope.json')), /no configuration found/);
  });
});
