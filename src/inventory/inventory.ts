import { dirname, join } from 'node:path';
import { MAX_LOCK_BYTES, MAX_SMALL_FILE_BYTES, isDirectory, isFile, readJson, type FileSystem } from '../fs.js';
import type { CollectorConfig, FrameworkId, FrameworkInfo, PackageItem, PackageSource, PackagesSection, RootPathSource } from '../types.js';
import { sha256Hex } from '../verify.js';
import {
  devDependencyNames,
  parsePackageJsonDependencies,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  type ParsedLock,
} from './lockfiles.js';

/**
 * Level 1 project inventory: project root discovery,
 * framework detection from the declared dependencies, npm package inventory
 * from the lockfile. Reads files only; never imports or executes project code.
 */
export const MAX_PACKAGES = 5000;

export const LOCKFILES: ReadonlyArray<{ file: string; source: PackageSource }> = [
  { file: 'package-lock.json', source: 'package-lock.json' },
  { file: 'yarn.lock', source: 'yarn.lock' },
  { file: 'pnpm-lock.yaml', source: 'pnpm-lock.yaml' },
];

/** Detection order matters: a Next.js app also depends on react, a NestJS app on express. */
const FRAMEWORKS: ReadonlyArray<{ id: FrameworkId; name: string; packages: string[] }> = [
  { id: 'nextjs', name: 'Next.js', packages: ['next'] },
  { id: 'nuxt', name: 'Nuxt', packages: ['nuxt', 'nuxt3'] },
  { id: 'remix', name: 'Remix', packages: ['@remix-run/react', '@remix-run/node', '@remix-run/dev'] },
  { id: 'sveltekit', name: 'SvelteKit', packages: ['@sveltejs/kit'] },
  { id: 'astro', name: 'Astro', packages: ['astro'] },
  { id: 'nestjs', name: 'NestJS', packages: ['@nestjs/core'] },
  { id: 'hono', name: 'Hono', packages: ['hono'] },
  { id: 'fastify', name: 'Fastify', packages: ['fastify'] },
  { id: 'koa', name: 'Koa', packages: ['koa'] },
  { id: 'express', name: 'Express', packages: ['express'] },
];

export interface RootResolution {
  root: string | null;
  source: RootPathSource;
}

export async function resolveRoot(fs: FileSystem, config: Pick<CollectorConfig, 'root_override'>, cwd: string): Promise<RootResolution> {
  if (typeof config.root_override === 'string' && config.root_override !== '') {
    return { root: config.root_override.replace(/[\\/]+$/, ''), source: 'override' };
  }

  if (await isFile(fs, join(cwd, 'package.json'))) {
    return { root: cwd, source: 'default' };
  }

  let candidate = cwd;

  for (let level = 1; level <= 3; level++) {
    const parent = dirname(candidate);

    if (parent === candidate) {
      break;
    }

    candidate = parent;

    if (await isFile(fs, join(candidate, 'package.json'))) {
      return { root: candidate, source: 'discovered' };
    }
  }

  return { root: null, source: 'default' };
}

export async function readPackageJson(fs: FileSystem, root: string): Promise<Record<string, unknown> | null> {
  const parsed = await readJson(fs, join(root, 'package.json'), MAX_SMALL_FILE_BYTES * 4);

  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

export function declaredDependencies(packageJson: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>();

  if (packageJson === null) {
    return out;
  }

  for (const field of ['dependencies', 'devDependencies']) {
    const deps = packageJson[field];

    if (typeof deps !== 'object' || deps === null) {
      continue;
    }

    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range === 'string' && !out.has(name)) {
        out.set(name, range);
      }
    }
  }

  return out;
}

export function detectFramework(packageJson: Record<string, unknown> | null, items: PackageItem[]): FrameworkInfo {
  const declared = declaredDependencies(packageJson);

  if (packageJson === null) {
    return { detected: 'unknown', name: null, version: null, detection_method: null };
  }

  for (const framework of FRAMEWORKS) {
    const match = framework.packages.find((name) => declared.has(name));

    if (match === undefined) {
      continue;
    }

    const locked = items.find((item) => item.name === match);

    return {
      detected: framework.id,
      name: framework.name,
      version: locked?.version ?? declared.get(match) ?? null,
      detection_method: locked !== undefined ? 'lockfile' : 'package_json',
    };
  }

  return { detected: 'unknown', name: null, version: null, detection_method: 'package_json' };
}

export interface PackagesResult {
  packages: PackagesSection | null;
  warnings: string[];
}

export async function collectPackages(fs: FileSystem, root: string, packageJson: Record<string, unknown> | null): Promise<PackagesResult> {
  const warnings: string[] = [];
  const devNames = devDependencyNames(packageJson);

  for (const { file, source } of LOCKFILES) {
    const path = join(root, file);
    const stat = await fs.stat(path);

    if (stat === null || !stat.isFile) {
      continue;
    }

    if (stat.size > MAX_LOCK_BYTES) {
      warnings.push('msg.lock_too_large');
      continue;
    }

    const raw = await fs.readFile(path, MAX_LOCK_BYTES);

    if (raw === null) {
      warnings.push('msg.not_readable');
      continue;
    }

    let parsed: ParsedLock;

    if (source === 'package-lock.json') {
      let json: unknown = null;

      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        warnings.push('msg.lock_unparsed');
        continue;
      }

      parsed = parsePackageLock(json);
    } else if (source === 'yarn.lock') {
      parsed = parseYarnLock(raw.toString('utf8'), devNames);
    } else {
      parsed = parsePnpmLock(raw.toString('utf8'), devNames);
    }

    return {
      packages: {
        ecosystem: 'npm',
        source,
        lock_hash: sha256Hex(raw),
        items: cap(parsed.items, warnings),
        dev_installed: await devPackagesInstalled(fs, root, devNames),
      },
      warnings,
    };
  }

  if (packageJson !== null) {
    const raw = await fs.readFile(join(root, 'package.json'), MAX_SMALL_FILE_BYTES * 4);

    return {
      packages: {
        ecosystem: 'npm',
        source: 'package.json',
        lock_hash: sha256Hex(raw ?? ''),
        items: cap(parsePackageJsonDependencies(packageJson).items, warnings),
        dev_installed: await devPackagesInstalled(fs, root, devNames),
      },
      warnings,
    };
  }

  return { packages: null, warnings };
}

function cap(items: PackageItem[], warnings: string[]): PackageItem[] {
  if (items.length <= MAX_PACKAGES) {
    return items;
  }

  warnings.push('msg.packages_truncated');

  return items.slice(0, MAX_PACKAGES);
}

/** True when any declared devDependency (first 25) is present in node_modules. */
async function devPackagesInstalled(fs: FileSystem, root: string, devNames: ReadonlySet<string>): Promise<boolean> {
  let probed = 0;

  for (const name of devNames) {
    if (probed++ >= 25) {
      break;
    }

    if (await isDirectory(fs, join(root, 'node_modules', ...name.split('/')))) {
      return true;
    }
  }

  return false;
}
