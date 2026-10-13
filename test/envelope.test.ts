import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { buildEnvelope, createCollector } from '../src/collector.js';
import { useFileSystem } from '../src/fs.js';
import { MANIFEST_ENV, buildManifest, parseManifest } from '../src/manifest.js';
import { nodeFileSystem } from '../src/fs.js';
import { MemoryNonceStore } from '../src/nonce.js';
import { VERSION } from '../src/version.js';
import { configFor, ed25519Key, nowSeconds, removeDir, signedHeaders, tempDir, writeTree } from './helpers.js';
import { validateEnvelope } from './schema.js';

const key = ed25519Key();
const config = configFor(key);
const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = tempDir();
  dirs.push(root);
  writeTree(root, files);

  return root;
}

after(() => dirs.forEach(removeDir));

afterEach(() => {
  useFileSystem(undefined);
  delete process.env[MANIFEST_ENV];
});

describe('Level 1 envelope', () => {
  it('is valid against the panel schema and carries the required header fields', async () => {
    const root = project({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '^4.19.0' } }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/express': { version: '4.19.2' } } }),
    });
    const envelope = await buildEnvelope(config, { cwd: root });

    assert.deepEqual(validateEnvelope(envelope), []);
    assert.equal(envelope.schema_version, 1);
    assert.equal(envelope.collector.name, 'sitetus-node');
    assert.equal(envelope.collector.version, VERSION);
    assert.equal(envelope.collector.lang, 'node');
    assert.match(envelope.collector.file_hash, /^[a-f0-9]{64}$/);
    assert.equal(envelope.project_key, config.project_key);
    assert.equal(envelope.mode, 'monitor');
    assert.equal(envelope.level, 1);
    assert.equal(envelope.runtime.node_version, process.versions.node);
    assert.equal(envelope.runtime.sapi, 'node');
    assert.equal(envelope.framework.detected, 'express');
    assert.equal(envelope.framework.version, '4.19.2');
    assert.equal(envelope.packages?.source, 'package-lock.json');
    assert.deepEqual(envelope.packages?.items, [{ name: 'express', version: '4.19.2', dev: false }]);
    assert.equal(envelope.meta.root_path_source, 'default');
    assert.deepEqual(
      envelope.health?.checks.map((check) => check.id),
      ['node_env', 'inspector_enabled', 'debug_env', 'source_maps', 'env_in_public', 'lockfile_missing', 'outdated_lockfile', 'git_dir_in_root'],
    );
    assert.match(envelope.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('never carries environment values or absolute paths', async () => {
    const root = project({ 'package.json': '{}', 'public/.env': 'TOP_SECRET_VALUE=1' });
    process.env['DEBUG'] = 'sitetus:secret-namespace';
    const json = JSON.stringify(await buildEnvelope(config, { cwd: root }));
    delete process.env['DEBUG'];

    assert.ok(!json.includes('TOP_SECRET_VALUE'));
    assert.ok(!json.includes('secret-namespace'));
    assert.ok(!json.includes(root.replace(/\\/g, '\\\\')));
  });

  it('falls back to the manifest when the filesystem is not available', async () => {
    const manifest = {
      manifest_version: 1,
      generated_at: '2026-10-03T00:00:00Z',
      collector_version: VERSION,
      collector_file_hash: 'a'.repeat(64),
      framework: { detected: 'nextjs', name: 'Next.js', version: '14.2.3', detection_method: 'lockfile' },
      packages: { ecosystem: 'npm', source: 'package-lock.json', lock_hash: 'b'.repeat(64), items: [{ name: 'next', version: '14.2.3' }], dev_installed: false },
    } as const;

    useFileSystem(null);
    const envelope = await buildEnvelope(config, { manifest: JSON.stringify(manifest) });

    assert.deepEqual(validateEnvelope(envelope), []);
    assert.equal(envelope.framework.detected, 'nextjs');
    assert.equal(envelope.packages?.lock_hash, 'b'.repeat(64));
    assert.equal(envelope.collector.file_hash, 'a'.repeat(64));
    assert.ok(envelope.meta.warnings.includes('msg.fs_unavailable'));
    assert.ok(envelope.meta.warnings.includes('msg.manifest_used'));
    assert.equal(envelope.health?.checks.find((check) => check.id === 'source_maps')?.message, 'msg.fs_unavailable');
  });

  it('reads the manifest from the environment variable and from the project file', async () => {
    const fs = (await nodeFileSystem())!;
    const source = project({ 'package.json': JSON.stringify({ dependencies: { fastify: '^4' } }), 'yarn.lock': 'fastify@^4:\n  version "4.26.2"\n' });
    const { manifest } = await buildManifest(fs, source);

    assert.equal(manifest.framework.detected, 'fastify');
    assert.equal(manifest.packages?.source, 'yarn.lock');
    assert.equal(parseManifest(JSON.parse(JSON.stringify(manifest)))?.packages?.items.length, 1);
    assert.equal(parseManifest({ manifest_version: 2 }), null);

    // No package.json in the working directory → the manifest next to it is used.
    const deployed = project({ 'sitetus.manifest.json': JSON.stringify(manifest) });
    const fromFile = await buildEnvelope(config, { cwd: deployed });
    assert.equal(fromFile.framework.detected, 'unknown', 'a directory without package.json and without override has no root');
    assert.ok(fromFile.meta.warnings.includes('msg.root_unknown'));

    const withOverride = await buildEnvelope({ ...config, root_override: deployed }, { cwd: deployed });
    assert.equal(withOverride.framework.detected, 'fastify');
    assert.ok(withOverride.meta.warnings.includes('msg.manifest_used'));

    process.env[MANIFEST_ENV] = JSON.stringify(manifest);
    const fromEnv = await buildEnvelope(config, { cwd: project({}) });
    assert.equal(fromEnv.framework.detected, 'fastify');
  });

  it('stays within the time budget on a plain project', async () => {
    const root = project({ 'package.json': '{}' });
    const envelope = await buildEnvelope(config, { cwd: root });

    assert.ok(envelope.meta.duration_ms < 2000);
  });
});

describe('Collector.handle', () => {
  it('returns the envelope with a JSON content type on a valid request and nothing on 404', async () => {
    const root = project({ 'package.json': '{}' });
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: root, nonceStore: new MemoryNonceStore(), now: () => now });

    const ok = await collector.handle({ method: 'get', path: `/${config.path}`, headers: signedHeaders(key, config, { timestamp: now }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(validateEnvelope(JSON.parse(ok.body ?? 'null')), []);

    const anonymous = await collector.handle({ method: 'GET', path: `/${config.path}`, headers: {} });
    assert.deepEqual(anonymous, { status: 404, headers: {}, body: null });
  });

  it('accepts Headers objects and array header values', async () => {
    const now = nowSeconds();
    const collector = createCollector({ config, cwd: project({ 'package.json': '{}' }), nonceStore: new MemoryNonceStore(), now: () => now });
    const signed = signedHeaders(key, config, { timestamp: now });

    assert.equal((await collector.handle({ method: 'GET', path: `/${config.path}`, headers: new Headers(signed) })).status, 200);

    const arrays = Object.fromEntries(Object.entries(signedHeaders(key, config, { timestamp: now })).map(([name, value]) => [name.toUpperCase(), [value]]));
    assert.equal((await collector.handle({ method: 'GET', path: `/${config.path}`, headers: arrays })).status, 200);
  });

  it('answers 404 instead of throwing when the configuration cannot be loaded', async () => {
    const collector = createCollector({ config: join(tempDir(), 'missing.json'), nonceStore: new MemoryNonceStore() });

    assert.equal((await collector.handle({ method: 'GET', path: '/x', headers: {} })).status, 404);
  });

  it('matches its own path with or without the trailing slash', async () => {
    const collector = createCollector({ config, nonceStore: new MemoryNonceStore() });

    assert.equal(await collector.mountPath(), `/${config.path}`);
    assert.equal(await collector.matches(`/${config.path}`), true);
    assert.equal(await collector.matches(`/${config.path}/`), true);
    assert.equal(await collector.matches(`/${config.path}/x`), false);
    assert.equal(await collector.matches('/'), false);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

    assert.equal(VERSION, packageJson.version);
  });
});
