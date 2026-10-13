import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pullExampleApp } from './pull.js';

/**
 * `npm run fixture`: pulls the example app once and saves the real envelope
 * to test/fixtures/envelope-express.json for the panel-side tests.
 */
const result = await pullExampleApp();

if (result.envelope === null) {
  process.stderr.write(`pull failed: ${result.status}\n`);
  process.exitCode = 1;
} else {
  const target = join(process.cwd(), 'test', 'fixtures', 'envelope-express.json');
  writeFileSync(target, `${JSON.stringify(result.envelope, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${target}\n`);
}
