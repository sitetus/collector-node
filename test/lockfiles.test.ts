import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parsePackageJsonDependencies, parsePackageLock, parsePnpmLock, parseYarnLock, sortItems } from '../src/inventory/lockfiles.js';

const fixture = (name: string): string => readFileSync(join(process.cwd(), 'test', 'fixtures', 'locks', name), 'utf8');

describe('package-lock.json', () => {
  it('flattens a v1 lock including nested dependencies', () => {
    const { items } = parsePackageLock(JSON.parse(fixture('package-lock-v1.json')));

    assert.deepEqual(items, [
      { name: 'accepts', version: '1.3.8', dev: false },
      { name: 'express', version: '4.18.2', dev: false },
      { name: '@types/node', version: '20.11.0', dev: true },
      { name: 'typescript', version: '5.4.5', dev: true },
    ]);
  });

  it('reads a v3 lock from the packages map, skipping the root and workspace links', () => {
    const { items } = parsePackageLock(JSON.parse(fixture('package-lock-v3.json')));

    assert.deepEqual(items, [
      { name: 'nanoid', version: '3.3.6', dev: false },
      { name: 'next', version: '14.2.3', dev: false },
      { name: 'postcss', version: '8.4.31', dev: false },
      { name: 'react', version: '18.3.1', dev: false },
      { name: '@esbuild/linux-x64', version: '0.21.5', dev: true },
      { name: 'typescript', version: '5.4.5', dev: true },
    ]);
  });

  it('never throws on garbage', () => {
    assert.deepEqual(parsePackageLock(null).items, []);
    assert.deepEqual(parsePackageLock({ packages: { 'node_modules/x': 'nope' } }).items, []);
    assert.deepEqual(parsePackageLock({ dependencies: { 'Bad Name': { version: '1.0.0' } } }).items, []);
  });
});

describe('yarn.lock', () => {
  it('parses the classic format and marks the project devDependencies', () => {
    const { items } = parseYarnLock(fixture('yarn-classic.lock'), new Set(['jest']));

    assert.deepEqual(items, [
      { name: '@babel/code-frame', version: '7.24.2' },
      { name: '@babel/core', version: '7.24.5' },
      { name: 'accepts', version: '1.3.8' },
      { name: 'express', version: '4.19.2' },
      { name: 'jest', version: '29.7.0', dev: true },
    ]);
  });

  it('parses the berry format, skipping __metadata and workspace entries', () => {
    const { items } = parseYarnLock(fixture('yarn-berry.lock'), new Set(['vitest']));

    assert.deepEqual(items, [
      { name: '@sveltejs/kit', version: '2.5.10' },
      { name: 'devalue', version: '5.0.0' },
      { name: 'vitest', version: '1.6.0', dev: true },
    ]);
  });
});

describe('pnpm-lock.yaml', () => {
  it('parses v6 keys with the leading slash, peer suffixes and dev flags', () => {
    const { items } = parsePnpmLock(fixture('pnpm-lock-v6.yaml'));

    assert.deepEqual(items, [
      { name: '@fastify/ajv-compiler', version: '3.5.0', dev: false },
      { name: 'fastify', version: '4.26.2', dev: false },
      { name: 'react-dom', version: '18.2.0', dev: false },
      { name: 'tsx', version: '4.7.1', dev: true },
    ]);
  });

  it('parses v9 keys and marks top-level devDependencies', () => {
    const { items } = parsePnpmLock(fixture('pnpm-lock-v9.yaml'), new Set(['vitest']));

    assert.deepEqual(items, [
      { name: '@scope/pkg', version: '1.0.0' },
      { name: '@types/node', version: '20.14.2' },
      { name: 'hono', version: '4.4.6' },
      { name: 'vitest', version: '1.6.0', dev: true },
    ]);
  });

  it('parses the v5 path form', () => {
    const { items } = parsePnpmLock('lockfileVersion: 5.4\n\npackages:\n\n  /lodash/4.17.21:\n    resolution: {integrity: x}\n    dev: false\n\n  /react-dom/18.2.0_react@18.2.0:\n    dev: false\n');

    assert.deepEqual(items, [
      { name: 'lodash', version: '4.17.21', dev: false },
      { name: 'react-dom', version: '18.2.0', dev: false },
    ]);
  });
});

describe('package.json fallback', () => {
  it('reports the declared ranges, production first', () => {
    const { items } = parsePackageJsonDependencies({ dependencies: { koa: '^2.15.0' }, devDependencies: { eslint: '^9.0.0' } });

    assert.deepEqual(items, [
      { name: 'koa', version: '^2.15.0', dev: false },
      { name: 'eslint', version: '^9.0.0', dev: true },
    ]);
  });
});

describe('sortItems', () => {
  it('puts production before dev and sorts by name within each group', () => {
    const sorted = sortItems([
      { name: 'z', version: '1', dev: true },
      { name: 'b', version: '1' },
      { name: 'a', version: '2', dev: false },
      { name: 'c', version: '1', dev: true },
    ]);

    assert.deepEqual(sorted.map((item) => item.name), ['a', 'b', 'c', 'z']);
  });
});
