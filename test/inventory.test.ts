import assert from 'node:assert/strict';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { nodeFileSystem } from '../src/fs.js';
import { debugEnv, envInPublic, gitDirInRoot, inspectorEnabled, level1Checks, lockfileMissing, nodeEnv, outdatedLockfile, sourceMaps } from '../src/health.js';
import { collectPackages, detectFramework, readPackageJson, resolveRoot } from '../src/inventory/inventory.js';
import { removeDir, tempDir, writeTree } from './helpers.js';

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const root = tempDir();
  dirs.push(root);
  writeTree(root, files);

  return root;
}

after(() => dirs.forEach(removeDir));

describe('project root', () => {
  it('uses the override, the working directory, or an ancestor with package.json', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'package.json': '{}', 'apps/web/index.js': '' });

    assert.deepEqual(await resolveRoot(fs, { root_override: '/srv/app/' }, root), { root: '/srv/app', source: 'override' });
    assert.deepEqual(await resolveRoot(fs, { root_override: null }, root), { root, source: 'default' });
    assert.deepEqual(await resolveRoot(fs, { root_override: null }, join(root, 'apps', 'web')), { root, source: 'discovered' });

    const empty = project({ 'a/b/c/d/e.txt': '' });
    assert.equal((await resolveRoot(fs, { root_override: null }, join(empty, 'a', 'b', 'c', 'd'))).root, null);
  });
});

describe('framework detection', () => {
  it('prefers the specific framework over the server it is built on, versions from the lockfile', () => {
    const packageJson = { dependencies: { next: '^14.0.0', react: '^18', express: '^4' } };

    assert.deepEqual(detectFramework(packageJson, [{ name: 'next', version: '14.2.3' }]), {
      detected: 'nextjs',
      name: 'Next.js',
      version: '14.2.3',
      detection_method: 'lockfile',
    });
    assert.deepEqual(detectFramework({ dependencies: { express: '^4.19.0' } }, []), {
      detected: 'express',
      name: 'Express',
      version: '^4.19.0',
      detection_method: 'package_json',
    });
    assert.equal(detectFramework({ devDependencies: { '@sveltejs/kit': '^2' } }, []).detected, 'sveltekit');
    assert.equal(detectFramework({ dependencies: { '@nestjs/core': '^10', express: '^4' } }, []).detected, 'nestjs');
    assert.equal(detectFramework({ dependencies: { lodash: '^4' } }, []).detected, 'unknown');
    assert.equal(detectFramework(null, []).detection_method, null);
  });
});

describe('packages section', () => {
  it('reads the first lockfile found and reports whether dev packages are installed', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({
      'package.json': JSON.stringify({ dependencies: { hono: '^4' }, devDependencies: { vitest: '^1' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\npackages:\n\n  hono@4.4.6:\n    resolution: {integrity: x}\n\n  vitest@1.6.0:\n    resolution: {integrity: y}\n",
      'node_modules/vitest/package.json': '{}',
    });

    const { packages, warnings } = await collectPackages(fs, root, await readPackageJson(fs, root));

    assert.equal(packages?.source, 'pnpm-lock.yaml');
    assert.match(packages?.lock_hash ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual(packages?.items, [
      { name: 'hono', version: '4.4.6' },
      { name: 'vitest', version: '1.6.0', dev: true },
    ]);
    assert.equal(packages?.dev_installed, true);
    assert.deepEqual(warnings, []);
  });

  it('falls back to package.json ranges without a lockfile', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'package.json': JSON.stringify({ dependencies: { koa: '^2.15.0' } }) });
    const { packages } = await collectPackages(fs, root, await readPackageJson(fs, root));

    assert.equal(packages?.source, 'package.json');
    assert.deepEqual(packages?.items, [{ name: 'koa', version: '^2.15.0', dev: false }]);
    assert.equal(packages?.dev_installed, false);
  });

  it('warns on an unparseable lock instead of failing', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'package.json': '{}', 'package-lock.json': '{not json' });
    const { packages, warnings } = await collectPackages(fs, root, await readPackageJson(fs, root));

    assert.equal(packages?.source, 'package.json');
    assert.deepEqual(warnings, ['msg.lock_unparsed']);
  });
});

describe('health checks', () => {
  it('classifies NODE_ENV without sending the value', () => {
    assert.deepEqual(nodeEnv({ NODE_ENV: 'production' }), { id: 'node_env', status: 'ok', value: true, detail: { value: 'production' } });
    assert.equal(nodeEnv({}).detail?.['value'], 'unset');
    assert.equal(nodeEnv({ NODE_ENV: 'staging' }).detail?.['value'], 'other');
    assert.equal(nodeEnv({ NODE_ENV: 'development' }).status, 'warn');
  });

  it('flags the inspector from NODE_OPTIONS, execArgv or an active session', () => {
    assert.equal(inspectorEnabled({ env: {}, execArgv: [], inspectorActive: false }).status, 'ok');
    assert.equal(inspectorEnabled({ env: { NODE_OPTIONS: '--max-old-space-size=4096 --inspect=0.0.0.0:9229' }, execArgv: [], inspectorActive: false }).status, 'fail');
    assert.equal(inspectorEnabled({ env: {}, execArgv: ['--inspect-brk'], inspectorActive: false }).status, 'fail');
    assert.equal(inspectorEnabled({ env: {}, execArgv: [], inspectorActive: true }).status, 'fail');
  });

  it('flags a non-empty DEBUG variable without its value', () => {
    assert.deepEqual(debugEnv({ DEBUG: 'app:*' }), { id: 'debug_env', status: 'warn', value: true });
    assert.equal(debugEnv({ DEBUG: '  ' }).status, 'ok');
    assert.equal(debugEnv({}).status, 'ok');
  });

  it('finds source maps in build output and the Next.js config flag', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'next.config.js': 'module.exports = { productionBrowserSourceMaps: true };', '.next/static/chunks/app.js.map': '{}', 'dist/a.map': '' });
    const clean = project({ 'dist/app.js': '' });

    const found = await sourceMaps(fs, root, Date.now() + 1000);
    assert.equal(found.status, 'warn');
    assert.deepEqual(found.detail, { map_files: 2, next_config_flag: true, budget_exhausted: false });
    assert.equal((await sourceMaps(fs, clean, Date.now() + 1000)).status, 'ok');
  });

  it('finds .env files in served directories (count and directory only)', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'public/.env': 'SECRET=1', 'public/.env.local': 'X=1', 'dist/.env.example': '', 'static/index.html': '' });
    const check = await envInPublic(fs, root);

    assert.equal(check.status, 'fail');
    assert.equal(check.value, 2);
    assert.deepEqual(check.detail, { dirs: 'public' });
    assert.ok(!JSON.stringify(check).includes('SECRET'));
  });

  it('reports a missing or outdated lockfile', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ 'package.json': '{}', 'package-lock.json': '{}' });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, 'package-lock.json'), old, old);

    assert.equal(lockfileMissing(null).status, 'warn');
    assert.equal(lockfileMissing('package.json').status, 'warn');
    assert.equal(lockfileMissing('yarn.lock').status, 'ok');

    const outdated = await outdatedLockfile(fs, root, 'package-lock.json');
    assert.equal(outdated.status, 'warn');
    assert.ok((outdated.detail?.['lag_seconds'] as number) >= 3500);
    assert.equal((await outdatedLockfile(fs, root, null)).status, 'unknown');
  });

  it('finds a .git directory inside a served directory', async () => {
    const fs = (await nodeFileSystem())!;
    const root = project({ '.git/HEAD': 'ref', 'public/.git/HEAD': 'ref', 'public/index.html': '' });
    const check = await gitDirInRoot(fs, root);

    assert.equal(check.status, 'fail');
    assert.deepEqual(check.detail, { dirs: 'public' });
  });

  it('returns unknown rows with a dictionary message when the filesystem or root is missing', async () => {
    const checks = await level1Checks({ fs: null, root: null, lockfile: null, env: {}, execArgv: [], inspectorActive: false, deadline: Date.now() + 1000 });

    assert.equal(checks.length, 8);
    assert.deepEqual(checks.filter((check) => check.status === 'unknown').map((check) => check.message), Array(5).fill('msg.fs_unavailable'));
  });
});
