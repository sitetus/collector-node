#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CONFIG_FILE, configFromPairing, decodePairingCode } from './config.js';
import { nodeFileSystem } from './fs.js';
import { resolveRoot } from './inventory/inventory.js';
import { MANIFEST_FILE, buildManifest } from './manifest.js';
import { VERSION } from './version.js';

/**
 * `npx sitetus-collector pair <code> [--path <segment>] [--out <file>]`
 * `npx sitetus-collector manifest [--root <dir>] [--out <file>]`
 *
 * `pair` turns the panel's pairing code into sitetus.collector.json — public
 * values only. `manifest` writes the build-time inventory for static and
 * serverless deployments.
 */
const USAGE = `sitetus-collector ${VERSION}

Usage:
  sitetus-collector pair <pairing-code> [--path <segment>] [--out <file>]
  sitetus-collector manifest [--root <dir>] [--out <file>]
  sitetus-collector --version
`;

function randomPath(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(16);
  let out = 'sitetus-';

  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }

  return out;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);

  return index !== -1 ? args[index + 1] : undefined;
}

async function pair(args: string[]): Promise<number> {
  let code: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';

    if (arg.startsWith('--')) {
      index++;
      continue;
    }

    code = arg;
    break;
  }

  if (code === undefined) {
    process.stderr.write('pair: the pairing code is missing\n');

    return 2;
  }

  const payload = decodePairingCode(code);

  if (payload === null) {
    process.stderr.write('pair: this is not a valid pairing code\n');

    return 2;
  }

  const requested = option(args, '--path');
  const path = requested ?? payload.path ?? randomPath();
  let config;

  try {
    config = configFromPairing(payload, path);
  } catch (error) {
    process.stderr.write(`pair: ${(error as Error).message}\n`);

    return 2;
  }

  const out = resolve(option(args, '--out') ?? CONFIG_FILE);
  const fs = await nodeFileSystem();

  if (fs === null || !(await fs.writeFile(out, `${JSON.stringify({ v: 1, ...config, paired_at: Math.floor(Date.now() / 1000) }, null, 2)}\n`))) {
    process.stderr.write(`pair: could not write ${out}\n`);

    return 1;
  }

  process.stdout.write(`Wrote ${out}\n`);
  process.stdout.write(`Collector path: /${config.path}\n`);

  if (payload.path === null && requested === undefined) {
    process.stdout.write('The pairing code carried no path; this one was drawn locally. Enter it in the panel as the collector path.\n');
  }

  return 0;
}

async function manifest(args: string[]): Promise<number> {
  const fs = await nodeFileSystem();

  if (fs === null) {
    process.stderr.write('manifest: the filesystem is not readable here\n');

    return 1;
  }

  const requestedRoot = option(args, '--root');
  const resolution = requestedRoot !== undefined
    ? { root: resolve(requestedRoot), source: 'override' as const }
    : await resolveRoot(fs, { root_override: null }, process.cwd());

  if (resolution.root === null) {
    process.stderr.write('manifest: no package.json found from the working directory\n');

    return 1;
  }

  const { manifest: built, warnings } = await buildManifest(fs, resolution.root);
  const out = resolve(option(args, '--out') ?? join(resolution.root, MANIFEST_FILE));

  if (!(await fs.writeFile(out, `${JSON.stringify(built, null, 2)}\n`))) {
    process.stderr.write(`manifest: could not write ${out}\n`);

    return 1;
  }

  process.stdout.write(`Wrote ${out} (${built.packages?.items.length ?? 0} packages from ${built.packages?.source ?? 'nothing'}, framework ${built.framework.detected})\n`);

  for (const warning of warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }

  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'pair':
      return pair(rest);
    case 'manifest':
      return manifest(rest);
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);

      return 0;
    default:
      process.stdout.write(USAGE);

      return command === undefined || command === '--help' || command === '-h' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
