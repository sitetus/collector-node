import type { Algo, CollectorConfig } from './types.js';
import { ALGOS, publicKeyObject } from './verify.js';

/**
 * Pairing code and configuration. The pairing code is the
 * panel's base64url JSON: {v, project_key, public_key, algo, expires_at,
 * nonce_file, modules, site, panel} — the same payload the WordPress plugin
 * decodes. Nothing in it is secret, and nothing undeclared is kept.
 *
 * The random URL segment is not part of the panel's code today (the
 * single-file build embeds it, the WordPress plugin has a fixed route), so
 * the code is accepted with an optional `path` / `install_path` field and,
 * when absent, `pair` draws one locally and tells the owner to set it in
 * the panel.
 */
export const PAIRING_VERSION = 1;

export const CONFIG_FILE = 'sitetus.collector.json';

export const CONFIG_ENV = 'SITETUS_COLLECTOR_CONFIG';

export const PROJECT_KEY_PATTERN = /^[a-z0-9]{8,64}$/;

export const PATH_PATTERN = /^[a-z0-9][a-z0-9-]{3,63}$/;

export const NONCE_FILE_PATTERN = /^\.sitetus-[a-z0-9]{6,32}\.json$/;

export const MODULE_PATTERN = /^[a-z_]{1,32}$/;

export interface PairingPayload {
  project_key: string;
  public_key: string;
  algo: Algo;
  expires_at: number | null;
  nonce_file: string | null;
  modules: string[];
  path: string | null;
  panel: string;
  site: string;
}

export function decodePairingCode(code: string): PairingPayload | null {
  const trimmed = code.trim();

  if (trimmed === '' || trimmed.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return null;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(trimmed, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;

  if (record['v'] !== PAIRING_VERSION) {
    return null;
  }

  let fields: ValidatedFields;

  try {
    fields = validateFields(record, false);
  } catch {
    return null;
  }

  return {
    ...fields,
    panel: typeof record['panel'] === 'string' ? safeUrl(record['panel']) : '',
    site: typeof record['site'] === 'string' ? record['site'].slice(0, 253) : '',
  };
}

function safeUrl(url: string): string {
  const value = url.trim().slice(0, 512);

  return /^https?:\/\/[a-z0-9.-]+(:[0-9]+)?(\/[^\s]*)?$/i.test(value) ? value : '';
}

interface ValidatedFields {
  project_key: string;
  public_key: string;
  algo: Algo;
  path: string | null;
  expires_at: number | null;
  nonce_file: string | null;
  modules: string[];
}

/**
 * The one validation both entry points pass through — the pairing code and
 * a configuration object (file, env variable, caller). Throws with the first
 * problem. The path may be absent only in a pairing code (`pair` draws one).
 */
function validateFields(record: Record<string, unknown>, pathRequired: boolean): ValidatedFields {
  const projectKey = record['project_key'];
  const publicKey = record['public_key'];
  const algo = record['algo'];
  const path = record['path'] ?? record['install_path'] ?? null;
  const nonceFile = record['nonce_file'] ?? null;
  const expiresAt = record['expires_at'];

  if (typeof projectKey !== 'string' || !PROJECT_KEY_PATTERN.test(projectKey)) {
    throw new Error('sitetus-collector: config.project_key is missing or malformed');
  }

  if (typeof publicKey !== 'string' || publicKey === '' || publicKey.length > 4096) {
    throw new Error('sitetus-collector: config.public_key is missing or malformed');
  }

  if (typeof algo !== 'string' || !(ALGOS as readonly string[]).includes(algo)) {
    throw new Error('sitetus-collector: config.algo must be ed25519 or rsa-sha256');
  }

  if (path === null ? pathRequired : typeof path !== 'string' || !PATH_PATTERN.test(path)) {
    throw new Error('sitetus-collector: config.path is missing or malformed');
  }

  if (nonceFile !== null && (typeof nonceFile !== 'string' || !NONCE_FILE_PATTERN.test(nonceFile))) {
    throw new Error('sitetus-collector: config.nonce_file must be a bare file name (.sitetus-<id>.json)');
  }

  if (publicKeyObject({ public_key: publicKey, algo: algo as Algo }) === null) {
    throw new Error('sitetus-collector: config.public_key is not a usable key for config.algo');
  }

  return {
    project_key: projectKey,
    public_key: publicKey,
    algo: algo as Algo,
    path: path as string | null,
    expires_at: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? Math.trunc(expiresAt) : null,
    nonce_file: nonceFile,
    modules: Array.isArray(record['modules'])
      ? record['modules'].filter((module): module is string => typeof module === 'string' && MODULE_PATTERN.test(module))
      : [],
  };
}

/**
 * Validates a configuration object (from the file, the env variable or the
 * caller) and returns a normalized copy, or throws with the first problem.
 */
export function normalizeConfig(input: unknown): CollectorConfig {
  if (typeof input !== 'object' || input === null) {
    throw new Error('sitetus-collector: config must be an object');
  }

  const record = input as Record<string, unknown>;
  const fields = validateFields(record, true);
  const rootOverride = record['root_override'];

  return {
    project_key: fields.project_key,
    public_key: fields.public_key,
    algo: fields.algo,
    path: fields.path ?? '',
    expires_at: fields.expires_at,
    modules: fields.modules,
    root_override: typeof rootOverride === 'string' && rootOverride !== '' ? rootOverride : null,
    nonce_file: fields.nonce_file,
    panel: typeof record['panel'] === 'string' ? record['panel'] : '',
    site: typeof record['site'] === 'string' ? record['site'] : '',
  };
}

export function configFromPairing(payload: PairingPayload, path: string): CollectorConfig {
  return normalizeConfig({
    project_key: payload.project_key,
    public_key: payload.public_key,
    algo: payload.algo,
    path,
    expires_at: payload.expires_at,
    modules: payload.modules,
    root_override: null,
    nonce_file: payload.nonce_file,
    panel: payload.panel,
    site: payload.site,
  });
}

/**
 * Resolution order: an explicit object → `SITETUS_COLLECTOR_CONFIG` (JSON)
 * → `SITETUS_COLLECTOR_CONFIG_FILE` → `./sitetus.collector.json`.
 */
export async function loadConfig(explicit?: CollectorConfig | string): Promise<CollectorConfig> {
  if (typeof explicit === 'object') {
    return normalizeConfig(explicit);
  }

  const env = process.env[CONFIG_ENV];

  if (typeof explicit !== 'string' && typeof env === 'string' && env.trim() !== '') {
    return normalizeConfig(parseJson(env, CONFIG_ENV));
  }

  const file = typeof explicit === 'string' ? explicit : (process.env['SITETUS_COLLECTOR_CONFIG_FILE'] ?? CONFIG_FILE);

  let raw: string;

  try {
    const fs = await import('node:fs/promises');
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(`sitetus-collector: no configuration found (run "npx sitetus-collector pair <code>" or set ${CONFIG_ENV})`);
  }

  return normalizeConfig(parseJson(raw, file));
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`sitetus-collector: ${source} is not valid JSON`);
  }
}
