/**
 * Public types. The envelope shape follows the collector specification and
 * the panel's envelope validation; the request/response pair is transport-neutral so every
 * adapter is a thin mapping on top of `Collector.handle()`.
 */

export type Algo = 'ed25519' | 'rsa-sha256';

export interface CollectorConfig {
  /** Installation identifier (not a secret); part of the signed material. */
  project_key: string;
  /** Ed25519: base64 of the raw 32-byte key. RSA: PEM (SubjectPublicKeyInfo). */
  public_key: string;
  algo: Algo;
  /** Random URL segment the panel pulls: `/<path>`. */
  path: string;
  /** Unix UTC seconds; null = never expires. */
  expires_at?: number | null;
  /** Opt-in modules selected in the panel; Level 1 of this collector runs none of them. */
  modules?: string[];
  /** Absolute project root; null = discover from the working directory. */
  root_override?: string | null;
  /** File name of the nonce store (only used by the file store). */
  nonce_file?: string | null;
  panel?: string;
  site?: string;
}

export type HeaderValue = string | string[] | undefined;

export interface CollectorRequest {
  method: string;
  /** URL path only (no query string), exactly as the server saw it. */
  path: string;
  headers: Record<string, HeaderValue> | Headers;
  /** Raw request body; the panel always sends an empty one. */
  body?: string | Uint8Array | null;
}

export interface CollectorResponse {
  status: 200 | 403 | 404;
  headers: Record<string, string>;
  /** JSON envelope on 200, null otherwise (404 carries no body by design). */
  body: string | null;
}

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export type DetailValue = string | number | boolean;

export interface HealthCheck {
  id: string;
  status: HealthStatus;
  value?: number | boolean | string;
  unit?: string;
  /** Key from the fixed dictionary (`msg.*`); never free text. */
  message?: string;
  /** At most 20 scalar entries, keys `[a-z0-9_]{1,64}`. */
  detail?: Record<string, DetailValue>;
}

export type FrameworkId =
  | 'nextjs'
  | 'nuxt'
  | 'remix'
  | 'sveltekit'
  | 'astro'
  | 'nestjs'
  | 'hono'
  | 'fastify'
  | 'koa'
  | 'express'
  | 'unknown';

export interface FrameworkInfo {
  detected: FrameworkId;
  name: string | null;
  version: string | null;
  detection_method: string | null;
}

export type PackageSource = 'package-lock.json' | 'yarn.lock' | 'pnpm-lock.yaml' | 'package.json';

export interface PackageItem {
  name: string;
  version: string;
  dev?: boolean;
}

export interface PackagesSection {
  ecosystem: 'npm';
  source: PackageSource;
  lock_hash: string;
  items: PackageItem[];
  dev_installed: boolean;
}

export type RootPathSource = 'default' | 'discovered' | 'override';

export interface Envelope {
  schema_version: 1;
  generated_at: string;
  collector: { name: string; version: string; lang: 'node'; file_hash: string };
  project_key: string;
  mode: 'monitor';
  level: 1;
  runtime: { node_version: string; sapi: 'node'; platform: string };
  framework: FrameworkInfo;
  packages?: PackagesSection;
  health?: { checks: HealthCheck[] };
  meta: { warnings: string[]; duration_ms: number; root_path_source: RootPathSource };
}

/**
 * Build-time inventory (`npx sitetus-collector manifest`): what the runtime
 * serves when the filesystem is not readable (static hosting, edge).
 */
export interface Manifest {
  manifest_version: 1;
  generated_at: string;
  collector_version: string;
  collector_file_hash: string | null;
  framework: FrameworkInfo;
  packages: PackagesSection | null;
}

export interface NonceStore {
  /** true = fresh (recorded now); false = replay; null = store not writable. */
  register(nonce: string, now: number): boolean | null | Promise<boolean | null>;
  /** Unix seconds of the last valid signed request; null when unknown (sleep rule not applicable). */
  lastValidRequestAt(): number | null | Promise<number | null>;
}
