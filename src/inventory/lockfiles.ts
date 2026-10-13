import type { PackageItem } from '../types.js';

/**
 * Lockfile parsers. Each returns the installed packages as {name, version,
 * dev?}; no constraint, URL, integrity hash or author ever leaves the file.
 * Parsing is best-effort and line-based for the YAML formats — a lockfile
 * that does not parse yields an empty list, never an exception.
 */
export const NPM_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;

export const MAX_VERSION_LENGTH = 200;

export interface ParsedLock {
  items: PackageItem[];
}

function push(items: Map<string, PackageItem>, name: string, version: string, dev: boolean | undefined): void {
  const cleanVersion = version.trim().replace(/^v/, '');

  if (!NPM_NAME_PATTERN.test(name) || cleanVersion === '' || cleanVersion.length > MAX_VERSION_LENGTH) {
    return;
  }

  const key = `${name}@${cleanVersion}`;
  const existing = items.get(key);

  if (existing === undefined) {
    const item: PackageItem = { name, version: cleanVersion };

    if (dev !== undefined) {
      item.dev = dev;
    }

    items.set(key, item);

    return;
  }

  // The same name@version reachable as both a prod and a dev dependency is a prod dependency.
  if (existing.dev === true && dev === false) {
    existing.dev = false;
  }
}

/** Production dependencies first (dev undefined counts as production), stable within each group. */
export function sortItems(items: Iterable<PackageItem>): PackageItem[] {
  const list = [...items];
  const production = list.filter((item) => item.dev !== true);
  const development = list.filter((item) => item.dev === true);
  const byName = (a: PackageItem, b: PackageItem): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);

  return [...production.sort(byName), ...development.sort(byName)];
}

/* ---------------------------------------------------------------- npm */

interface NpmLockV1Dependency {
  version?: unknown;
  dev?: unknown;
  dependencies?: Record<string, NpmLockV1Dependency>;
}

export function parsePackageLock(raw: unknown): ParsedLock {
  const items = new Map<string, PackageItem>();

  if (typeof raw !== 'object' || raw === null) {
    return { items: [] };
  }

  const lock = raw as { lockfileVersion?: unknown; packages?: unknown; dependencies?: unknown };

  if (typeof lock.packages === 'object' && lock.packages !== null) {
    // v2/v3: "node_modules/a/node_modules/b" → b; the root ("") and workspace links are not packages.
    for (const [path, entry] of Object.entries(lock.packages as Record<string, unknown>)) {
      if (path === '' || typeof entry !== 'object' || entry === null) {
        continue;
      }

      const record = entry as { version?: unknown; dev?: unknown; link?: unknown };
      const marker = path.lastIndexOf('node_modules/');

      if (marker === -1 || record.link === true || typeof record.version !== 'string') {
        continue;
      }

      push(items, path.slice(marker + 'node_modules/'.length), record.version, record.dev === true ? true : false);
    }

    return { items: sortItems(items.values()) };
  }

  if (typeof lock.dependencies === 'object' && lock.dependencies !== null) {
    const walk = (dependencies: Record<string, NpmLockV1Dependency>): void => {
      for (const [name, entry] of Object.entries(dependencies)) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }

        if (typeof entry.version === 'string') {
          push(items, name, entry.version, entry.dev === true ? true : false);
        }

        if (typeof entry.dependencies === 'object' && entry.dependencies !== null) {
          walk(entry.dependencies);
        }
      }
    };

    walk(lock.dependencies as Record<string, NpmLockV1Dependency>);
  }

  return { items: sortItems(items.values()) };
}

/* --------------------------------------------------------------- yarn */

function yarnEntryName(descriptor: string): string | null {
  // "@scope/name@npm:^1.0.0" | "name@^1.0.0" | "name@npm:1.0.0" | "@scope/name@workspace:."
  const trimmed = descriptor.trim().replace(/^"|"$/g, '');
  const at = trimmed.indexOf('@', trimmed.startsWith('@') ? 1 : 0);

  if (at <= 0) {
    return null;
  }

  return trimmed.slice(0, at);
}

/**
 * yarn.lock, classic (v1 — `version "1.2.3"`) and berry (`version: 1.2.3`).
 * `devNames` marks the project's top-level devDependencies; transitive
 * entries carry no dev flag because the lockfile does not know it.
 */
export function parseYarnLock(text: string, devNames: ReadonlySet<string> = new Set()): ParsedLock {
  const items = new Map<string, PackageItem>();
  const lines = text.split(/\r?\n/);
  let currentNames: string[] = [];
  let isWorkspace = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ') && line.endsWith(':')) {
      const header = line.slice(0, -1);

      if (header === '__metadata') {
        currentNames = [];
        continue;
      }

      currentNames = header
        .split(',')
        .map(yarnEntryName)
        .filter((name): name is string => name !== null);
      isWorkspace = /@workspace:|@portal:|@link:/.test(header);
      continue;
    }

    if (currentNames.length === 0 || isWorkspace) {
      continue;
    }

    const match = /^\s{2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);

    if (match === null) {
      continue;
    }

    for (const name of new Set(currentNames)) {
      push(items, name, match[1] ?? '', devNames.has(name) ? true : undefined);
    }

    currentNames = [];
  }

  return { items: sortItems(items.values()) };
}

/* --------------------------------------------------------------- pnpm */

function pnpmPackageKey(key: string): { name: string; version: string } | null {
  // v9: "name@1.2.3", "@scope/name@1.2.3(peer@x)"; v6: "/name@1.2.3"; v5: "/name/1.2.3"
  let cleaned = key.trim().replace(/^['"]|['"]$/g, '').replace(/\(.*\)$/, '');

  if (cleaned.startsWith('/')) {
    cleaned = cleaned.slice(1);
  }

  // A scope is part of the name; the separator after it tells the lock version apart.
  const scopeEnd = cleaned.startsWith('@') ? cleaned.indexOf('/') + 1 : 0;
  const rest = cleaned.slice(scopeEnd);
  const slash = rest.indexOf('/');
  const at = rest.indexOf('@');
  let name: string;
  let version: string;

  if (slash > 0 && (at === -1 || slash < at)) {
    name = cleaned.slice(0, scopeEnd + slash);
    version = rest.slice(slash + 1);
  } else if (at > 0) {
    name = cleaned.slice(0, scopeEnd + at);
    version = rest.slice(at + 1);
  } else {
    return null;
  }

  // v5/v6 peer suffix: "1.2.3_react@18.0.0" → "1.2.3"
  version = version.replace(/_.*$/, '');

  return version === '' ? null : { name, version };
}

/**
 * pnpm-lock.yaml v5/v6/v9: the `packages:` map keys carry name and version;
 * v5/v6 entries say `dev: true|false`, v9 only the importers do, so the
 * project's own devDependencies mark top-level entries there.
 */
export function parsePnpmLock(text: string, devNames: ReadonlySet<string> = new Set()): ParsedLock {
  const items = new Map<string, PackageItem>();
  const lines = text.split(/\r?\n/);
  let inPackages = false;
  let current: { name: string; version: string } | null = null;
  let currentDev: boolean | undefined;

  const flush = (): void => {
    if (current !== null) {
      push(items, current.name, current.version, currentDev ?? (devNames.has(current.name) ? true : undefined));
    }

    current = null;
    currentDev = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ')) {
      flush();
      inPackages = line === 'packages:';
      continue;
    }

    if (!inPackages) {
      continue;
    }

    const keyMatch = /^ {2}(\S.*?):\s*$/.exec(line);

    if (keyMatch !== null) {
      flush();
      current = pnpmPackageKey(keyMatch[1] ?? '');
      continue;
    }

    const devMatch = /^ {4}dev:\s+(true|false)\s*$/.exec(line);

    if (devMatch !== null && current !== null) {
      currentDev = devMatch[1] === 'true';
    }
  }

  flush();

  return { items: sortItems(items.values()) };
}

/* ------------------------------------------------------- package.json */

/**
 * Without a lockfile the only honest inventory is the declared ranges —
 * marked by `source: package.json` so the panel knows these are not
 * resolved versions.
 */
export function parsePackageJsonDependencies(raw: unknown): ParsedLock {
  const items = new Map<string, PackageItem>();

  if (typeof raw !== 'object' || raw === null) {
    return { items: [] };
  }

  const record = raw as { dependencies?: unknown; devDependencies?: unknown };

  for (const [field, dev] of [
    ['dependencies', false],
    ['devDependencies', true],
  ] as const) {
    const deps = record[field];

    if (typeof deps !== 'object' || deps === null) {
      continue;
    }

    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof range === 'string') {
        push(items, name, range, dev);
      }
    }
  }

  return { items: sortItems(items.values()) };
}

export function devDependencyNames(packageJson: unknown): Set<string> {
  if (typeof packageJson !== 'object' || packageJson === null) {
    return new Set();
  }

  const deps = (packageJson as { devDependencies?: unknown }).devDependencies;

  return typeof deps === 'object' && deps !== null ? new Set(Object.keys(deps)) : new Set();
}
