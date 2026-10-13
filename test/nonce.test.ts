import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { FileNonceStore, MAX_ENTRIES, MemoryNonceStore, WINDOW_SECONDS } from '../src/nonce.js';
import { removeDir, tempDir } from './helpers.js';

describe('MemoryNonceStore', () => {
  it('records a fresh nonce and rejects the replay', () => {
    const store = new MemoryNonceStore();

    assert.equal(store.register('a', 1000), true);
    assert.equal(store.register('a', 1001), false);
    assert.equal(store.register('b', 1001), true);
  });

  it('prunes nonces outside twice the skew window', () => {
    const store = new MemoryNonceStore();

    store.register('old', 1000);
    assert.equal(store.register('old', 1000 + WINDOW_SECONDS), false);
    assert.equal(store.register('old', 1000 + WINDOW_SECONDS + 1), true);
  });

  it('keeps at most the last 1000 entries', () => {
    const store = new MemoryNonceStore();

    for (let index = 0; index < MAX_ENTRIES + 10; index++) {
      store.register(`n${index}`, 5000);
    }

    assert.equal(store.size(), MAX_ENTRIES);
    assert.equal(store.register('n0', 5000), true, 'the oldest entry was evicted');
  });

  it('does not know a last valid request time (sleep rule not applicable)', () => {
    assert.equal(new MemoryNonceStore().lastValidRequestAt(), null);
  });
});

describe('FileNonceStore', () => {
  const dir = tempDir();

  after(() => removeDir(dir));

  it('persists the PHP layout with last_valid and survives a reload', async () => {
    const path = join(dir, '.sitetus-abcdef.json');
    const store = new FileNonceStore(path);

    assert.equal(await store.lastValidRequestAt(), null);
    assert.equal(await store.register('a', 2000), true);
    assert.equal(await store.register('a', 2001), false);

    const raw = JSON.parse(readFileSync(path, 'utf8')) as { last_valid: number; nonces: Record<string, number> };
    assert.equal(raw.last_valid, 2000);
    assert.deepEqual(raw.nonces, { a: 2000 });

    const reloaded = new FileNonceStore(path);
    assert.equal(await reloaded.lastValidRequestAt(), 2000);
    assert.equal(await reloaded.register('a', 2002), false);
  });

  it('serializes concurrent registrations of the same nonce', async () => {
    const store = new FileNonceStore(join(dir, '.sitetus-concurrent.json'));
    const results = await Promise.all(['x', 'x', 'x', 'y'].map((nonce) => store.register(nonce, 3000)));

    assert.deepEqual(results.filter((result) => result === true).length, 2);
  });

  it('answers null when the store cannot be written', async () => {
    const store = new FileNonceStore(join(dir, 'missing-dir', 'nested', '.sitetus-x.json'));

    assert.equal(await store.register('a', 4000), null);
  });
});
