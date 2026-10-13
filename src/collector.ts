import { MAX_BODY, declaredLength, methodAllowed, notFound, type RequestHead } from './body.js';
import { loadConfig } from './config.js';
import { nodeFileSystem } from './fs.js';
import { level1Checks } from './health.js';
import { collectPackages, detectFramework, readPackageJson, resolveRoot } from './inventory/inventory.js';
import { loadManifest } from './manifest.js';
import { FileNonceStore, MemoryNonceStore } from './nonce.js';
import { selfFileHash } from './selfhash.js';
import type { CollectorConfig, CollectorRequest, CollectorResponse, Envelope, FrameworkInfo, Manifest, NonceStore, PackagesSection, RootPathSource } from './types.js';
import { RequestVerifier, normalizeHeaders } from './verify.js';
import { BUDGET_MS, COLLECTOR_NAME, SCHEMA_VERSION, VERSION } from './version.js';

export interface CollectorOptions {
  /** Configuration object, or a path to the JSON file; omitted = env/file resolution. */
  config?: CollectorConfig | string;
  /** Build-time manifest object or JSON string; omitted = env/file resolution. */
  manifest?: Manifest | string;
  /** Custom nonce store; default: file store when SITETUS_NONCE_FILE is set, memory store otherwise. */
  nonceStore?: NonceStore;
  /** Working directory the project root is discovered from (default: process.cwd()). */
  cwd?: string;
  /** Clock override for tests (unix seconds). */
  now?: () => number;
  /** Collector name override for wrappers; the envelope is otherwise identical. */
  collectorName?: string;
}

export interface Collector {
  /** Resolved configuration (public values only). */
  readonly config: Promise<CollectorConfig>;
  /** The URL path the panel pulls, without trailing slash: `/<path>`. */
  mountPath(): Promise<string>;
  /** True when `path` is the collector's own path, with or without the trailing slash. */
  matches(path: string): Promise<boolean>;
  /** True when the last segment of `path` is the collector's path — also under a mount prefix (`/api/<path>`). */
  serves(path: string): Promise<boolean>;
  /**
   * The gate every adapter passes before a body is read: allowed method,
   * collector path, `Content-Length` within `MAX_BODY`. Never throws.
   */
  admits(head: RequestHead): Promise<boolean>;
  handle(request: CollectorRequest): Promise<CollectorResponse>;
  /** Level 1 envelope for an already verified request. */
  envelope(): Promise<Envelope>;
}

export function createCollector(options: CollectorOptions = {}): Collector {
  const configPromise = loadConfig(options.config);
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const nonceStore = options.nonceStore ?? defaultNonceStore();
  let verifier: Promise<RequestVerifier> | null = null;

  const getVerifier = (): Promise<RequestVerifier> => {
    if (verifier === null) {
      verifier = configPromise.then((config) => new RequestVerifier(config, nonceStore));
    }

    return verifier;
  };

  const mountPath = async (): Promise<string> => `/${(await configPromise).path}`;

  const serves = async (path: string): Promise<boolean> => {
    const own = await mountPath();
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;

    return trimmed.endsWith(own);
  };

  const admits = async (head: RequestHead): Promise<boolean> => {
    try {
      if (!methodAllowed(head.method) || !(await serves(head.path))) {
        return false;
      }

      const length = declaredLength(normalizeHeaders(head.headers));

      return length === null || (length !== false && length <= MAX_BODY);
    } catch {
      return false;
    }
  };

  return {
    config: configPromise,
    mountPath,
    async matches(path: string): Promise<boolean> {
      const own = await mountPath();

      return path === own || path === `${own}/`;
    },
    serves,
    admits,
    async handle(request: CollectorRequest): Promise<CollectorResponse> {
      let result: { status: 200 | 403 | 404; headers: Record<string, string> };

      try {
        const body = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : request.body ?? new Uint8Array(0);

        if (!(await admits(request)) || body.byteLength > MAX_BODY) {
          return notFound();
        }

        result = await (await getVerifier()).verify(request.method.toUpperCase(), request.path, normalizeHeaders(request.headers), body, now());
      } catch {
        // A broken configuration must not turn into a stack trace: unverifiable = 404.
        return notFound();
      }

      if (result.status !== 200) {
        return { status: result.status, headers: result.headers, body: null };
      }

      const envelope = await buildEnvelope(await configPromise, options);

      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) };
    },
    async envelope(): Promise<Envelope> {
      return buildEnvelope(await configPromise, options);
    },
  };
}

function defaultNonceStore(): NonceStore {
  const file = process.env['SITETUS_NONCE_FILE'];

  return typeof file === 'string' && file.trim() !== '' ? new FileNonceStore(file.trim()) : new MemoryNonceStore();
}

export async function buildEnvelope(config: CollectorConfig, options: Pick<CollectorOptions, 'manifest' | 'cwd' | 'collectorName'> = {}): Promise<Envelope> {
  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  const warnings: string[] = [];
  const fs = await nodeFileSystem();
  const cwd = options.cwd ?? process.cwd();

  let root: string | null = null;
  let rootSource: RootPathSource = 'default';
  let framework: FrameworkInfo = { detected: 'unknown', name: null, version: null, detection_method: null };
  let packages: PackagesSection | null = null;
  let fileHash: string | null = null;
  let live = false;

  if (fs !== null) {
    const resolution = await resolveRoot(fs, config, cwd);
    root = resolution.root;
    rootSource = resolution.source;
    fileHash = await selfFileHash();

    if (root !== null) {
      const packageJson = await readPackageJson(fs, root);
      const result = await collectPackages(fs, root, packageJson);
      warnings.push(...result.warnings);
      packages = result.packages;
      framework = detectFramework(packageJson, packages?.items ?? []);
      live = packageJson !== null;
    }
  } else {
    warnings.push('msg.fs_unavailable');
  }

  if (!live) {
    const manifest = await loadManifest(options.manifest, fs, root);

    if (manifest !== null) {
      framework = manifest.framework;
      packages = manifest.packages;
      fileHash = fileHash ?? manifest.collector_file_hash;
      warnings.push('msg.manifest_used');
    } else if (fs !== null) {
      warnings.push('msg.root_unknown');
    }
  }

  const checks = await level1Checks({
    fs,
    root,
    lockfile: packages?.source ?? null,
    env: process.env,
    execArgv: process.execArgv,
    inspectorActive: await inspectorActive(),
    deadline,
  });

  const envelope: Envelope = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    collector: { name: options.collectorName ?? COLLECTOR_NAME, version: VERSION, lang: 'node', file_hash: fileHash ?? 'unavailable' },
    project_key: config.project_key,
    mode: 'monitor',
    level: 1,
    runtime: { node_version: process.versions.node, sapi: 'node', platform: process.platform },
    framework,
    meta: { warnings: [...new Set(warnings)], duration_ms: 0, root_path_source: rootSource },
  };

  if (packages !== null) {
    envelope.packages = packages;
  }

  envelope.health = { checks };
  envelope.meta.duration_ms = Date.now() - startedAt;

  return envelope;
}

async function inspectorActive(): Promise<boolean> {
  try {
    const inspector = await import('node:inspector');

    return typeof inspector.url === 'function' && inspector.url() !== undefined;
  } catch {
    return false;
  }
}
