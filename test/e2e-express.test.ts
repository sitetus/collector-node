import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pullExampleApp } from '../examples/express/pull.js';
import { ed25519Key, rsaKey } from './helpers.js';
import { validateEnvelope } from './schema.js';

describe('end to end: Express app pulled over HTTP', () => {
  for (const [label, make] of [
    ['ed25519', ed25519Key],
    ['rsa-sha256', rsaKey],
  ] as const) {
    it(`answers a signed pull with a schema-valid envelope (${label})`, async () => {
      const result = await pullExampleApp(make());

      assert.equal(result.status, 200, result.body);
      assert.equal(result.headers['content-type'], 'application/json');
      assert.equal(result.headers['x-powered-by'], undefined);
      assert.deepEqual(validateEnvelope(result.envelope), []);
      assert.equal(result.envelope?.collector.name, 'sitetus-node');
      assert.equal(result.envelope?.framework.detected, 'express');
      assert.equal(result.envelope?.packages?.source, 'package-lock.json');
      assert.ok((result.envelope?.packages?.items.length ?? 0) > 0);
    });
  }

  it('ships a committed fixture that still validates', () => {
    const path = join(process.cwd(), 'test', 'fixtures', 'envelope-express.json');

    assert.ok(existsSync(path), 'run `npm run fixture` to create test/fixtures/envelope-express.json');
    assert.deepEqual(validateEnvelope(JSON.parse(readFileSync(path, 'utf8'))), []);
  });
});
