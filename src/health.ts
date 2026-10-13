import { join } from 'node:path';
import { MAX_SMALL_FILE_BYTES, isDirectory, isFile, type FileSystem } from './fs.js';
import type { HealthCheck, PackageSource } from './types.js';

/**
 * Level 1 health checks for a Node project: statuses, counts and flags only
 * — never an environment value, a path outside the project root or file
 * contents. Messages are keys from the fixed dictionary (msg.*).
 */
export const STATIC_DIRS = ['public', 'static', 'dist', 'build', 'out'] as const;

export const SOURCE_MAP_DIRS = [join('.next', 'static'), 'dist', 'build'] as const;

export const MAX_WALK_ENTRIES = 2000;

export const MAX_WALK_DEPTH = 4;

export interface HealthContext {
  fs: FileSystem | null;
  root: string | null;
  lockfile: PackageSource | null;
  env: NodeJS.ProcessEnv;
  execArgv: string[];
  inspectorActive: boolean;
  deadline: number;
}

export async function level1Checks(context: HealthContext): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [nodeEnv(context.env), inspectorEnabled(context), debugEnv(context.env)];

  if (context.fs === null || context.root === null) {
    for (const id of ['source_maps', 'env_in_public', 'lockfile_missing', 'outdated_lockfile', 'git_dir_in_root']) {
      checks.push({ id, status: 'unknown', message: context.fs === null ? 'msg.fs_unavailable' : 'msg.root_unknown' });
    }

    return checks;
  }

  const { fs, root } = context;

  checks.push(await sourceMaps(fs, root, context.deadline));
  checks.push(await envInPublic(fs, root));
  checks.push(lockfileMissing(context.lockfile));
  checks.push(await outdatedLockfile(fs, root, context.lockfile));
  checks.push(await gitDirInRoot(fs, root));

  return checks;
}

/** NODE_ENV as a class, never the raw value. */
export function nodeEnv(env: NodeJS.ProcessEnv): HealthCheck {
  const value = env['NODE_ENV'];
  const kind = value === undefined || value === '' ? 'unset' : value === 'production' ? 'production' : value === 'development' || value === 'test' ? value : 'other';

  return { id: 'node_env', status: kind === 'production' ? 'ok' : 'warn', value: kind === 'production', detail: { value: kind } };
}

export function inspectorEnabled(context: Pick<HealthContext, 'env' | 'execArgv' | 'inspectorActive'>): HealthCheck {
  const inOptions = /(^|\s)--inspect/.test(context.env['NODE_OPTIONS'] ?? '');
  const inArgv = context.execArgv.some((arg) => arg.startsWith('--inspect'));
  const enabled = inOptions || inArgv || context.inspectorActive;

  return {
    id: 'inspector_enabled',
    status: enabled ? 'fail' : 'ok',
    value: enabled,
    detail: { node_options: inOptions, exec_argv: inArgv, active: context.inspectorActive },
  };
}

export function debugEnv(env: NodeJS.ProcessEnv): HealthCheck {
  const set = typeof env['DEBUG'] === 'string' && env['DEBUG'].trim() !== '';

  return { id: 'debug_env', status: set ? 'warn' : 'ok', value: set };
}

export async function sourceMaps(fs: FileSystem, root: string, deadline: number): Promise<HealthCheck> {
  let configFlag = false;

  for (const name of ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts']) {
    const raw = await fs.readFile(join(root, name), MAX_SMALL_FILE_BYTES);

    if (raw !== null && /productionBrowserSourceMaps\s*:\s*true/.test(raw.toString('utf8'))) {
      configFlag = true;
      break;
    }
  }

  let mapFiles = 0;
  let budgetExhausted = false;

  for (const dir of SOURCE_MAP_DIRS) {
    const result = await countFiles(fs, join(root, dir), (name) => name.endsWith('.map'), deadline);
    mapFiles += result.count;
    budgetExhausted = budgetExhausted || result.exhausted;
  }

  const found = configFlag || mapFiles > 0;

  return {
    id: 'source_maps',
    status: found ? 'warn' : 'ok',
    value: found,
    detail: { map_files: mapFiles, next_config_flag: configFlag, budget_exhausted: budgetExhausted },
  };
}

export async function envInPublic(fs: FileSystem, root: string): Promise<HealthCheck> {
  let count = 0;
  const dirs: string[] = [];

  for (const dir of STATIC_DIRS) {
    const entries = await fs.readdir(join(root, dir));

    if (entries === null) {
      continue;
    }

    const hits = entries.filter((entry) => entry.isFile && /^\.env(\..+)?$/.test(entry.name) && !entry.name.endsWith('.example')).length;

    if (hits > 0) {
      count += hits;
      dirs.push(dir);
    }
  }

  return { id: 'env_in_public', status: count > 0 ? 'fail' : 'ok', value: count, detail: { dirs: dirs.join(',') } };
}

export function lockfileMissing(lockfile: PackageSource | null): HealthCheck {
  const missing = lockfile === null || lockfile === 'package.json';

  return { id: 'lockfile_missing', status: missing ? 'warn' : 'ok', value: missing };
}

export async function outdatedLockfile(fs: FileSystem, root: string, lockfile: PackageSource | null): Promise<HealthCheck> {
  if (lockfile === null || lockfile === 'package.json') {
    return { id: 'outdated_lockfile', status: 'unknown', message: 'msg.path_missing' };
  }

  const manifest = await fs.stat(join(root, 'package.json'));
  const lock = await fs.stat(join(root, lockfile));

  if (manifest === null || lock === null) {
    return { id: 'outdated_lockfile', status: 'unknown', message: 'msg.not_readable' };
  }

  const outdated = lock.mtimeMs < manifest.mtimeMs - 1000;

  return {
    id: 'outdated_lockfile',
    status: outdated ? 'warn' : 'ok',
    value: outdated,
    detail: { lag_seconds: Math.max(0, Math.round((manifest.mtimeMs - lock.mtimeMs) / 1000)) },
  };
}

/** A `.git` directory inside a directory that is served as static files. */
export async function gitDirInRoot(fs: FileSystem, root: string): Promise<HealthCheck> {
  const dirs: string[] = [];

  for (const dir of STATIC_DIRS) {
    if (await isDirectory(fs, join(root, dir, '.git')) || await isFile(fs, join(root, dir, '.git'))) {
      dirs.push(dir);
    }
  }

  return { id: 'git_dir_in_root', status: dirs.length > 0 ? 'fail' : 'ok', value: dirs.length, detail: { dirs: dirs.join(',') } };
}

async function countFiles(
  fs: FileSystem,
  dir: string,
  match: (name: string) => boolean,
  deadline: number,
): Promise<{ count: number; exhausted: boolean }> {
  let count = 0;
  let visited = 0;
  let exhausted = false;

  const walk = async (path: string, depth: number): Promise<void> => {
    if (exhausted || depth > MAX_WALK_DEPTH) {
      return;
    }

    const entries = await fs.readdir(path);

    if (entries === null) {
      return;
    }

    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES || Date.now() > deadline) {
        exhausted = true;

        return;
      }

      if (entry.isFile && match(entry.name)) {
        count++;
      } else if (entry.isDirectory && entry.name !== 'node_modules') {
        await walk(join(path, entry.name), depth + 1);
      }
    }
  };

  await walk(dir, 0);

  return { count, exhausted };
}
