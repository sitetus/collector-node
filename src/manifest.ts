import { join } from 'node:path';
import { MAX_SMALL_FILE_BYTES, readJson, type FileSystem } from './fs.js';
import { collectPackages, detectFramework, readPackageJson } from './inventory/inventory.js';
import { selfFileHash } from './selfhash.js';
import type { Manifest } from './types.js';
import { VERSION } from './version.js';

/**
 * Build-time manifest (`npx sitetus-collector manifest`): the inventory a
 * static or serverless deployment serves when the filesystem is not
 * readable at request time. The runtime prefers live reads and falls back
 * to this file (or the `SITETUS_COLLECTOR_MANIFEST` JSON variable).
 */
export const MANIFEST_FILE = 'sitetus.manifest.json';

export const MANIFEST_ENV = 'SITETUS_COLLECTOR_MANIFEST';

export async function buildManifest(fs: FileSystem, root: string): Promise<{ manifest: Manifest; warnings: string[] }> {
  const packageJson = await readPackageJson(fs, root);
  const { packages, warnings } = await collectPackages(fs, root, packageJson);

  return {
    manifest: {
      manifest_version: 1,
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      collector_version: VERSION,
      collector_file_hash: await selfFileHash(),
      framework: detectFramework(packageJson, packages?.items ?? []),
      packages,
    },
    warnings,
  };
}

export function parseManifest(input: unknown): Manifest | null {
  if (typeof input !== 'object' || input === null) {
    return null;
  }

  const record = input as Partial<Manifest>;

  if (record.manifest_version !== 1 || typeof record.framework !== 'object' || record.framework === null) {
    return null;
  }

  return {
    manifest_version: 1,
    generated_at: typeof record.generated_at === 'string' ? record.generated_at : '',
    collector_version: typeof record.collector_version === 'string' ? record.collector_version : '',
    collector_file_hash: typeof record.collector_file_hash === 'string' ? record.collector_file_hash : null,
    framework: record.framework,
    packages: typeof record.packages === 'object' && record.packages !== null ? record.packages : null,
  };
}

/**
 * Resolution: explicit value → env JSON → `<root>/sitetus.manifest.json`
 * (when the filesystem is readable) → null.
 */
export async function loadManifest(explicit: Manifest | string | undefined, fs: FileSystem | null, root: string | null): Promise<Manifest | null> {
  if (typeof explicit === 'object') {
    return parseManifest(explicit);
  }

  const env = process.env[MANIFEST_ENV];
  const raw = typeof explicit === 'string' ? explicit : env;

  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return parseManifest(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  if (fs !== null && root !== null) {
    return parseManifest(await readJson(fs, join(root, MANIFEST_FILE), MAX_SMALL_FILE_BYTES * 64));
  }

  return null;
}
