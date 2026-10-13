import { fileURLToPath } from 'node:url';
import { nodeFileSystem } from './fs.js';
import { sha256Hex } from './verify.js';

/**
 * `collector.file_hash`: SHA-256 of the running entry file, so the panel can
 * compare it with the published build. With tsup shims
 * `import.meta.url` resolves in both the ESM and the CJS build. When the file
 * cannot be read (edge bundle), the manifest's build-time hash stands in.
 */
let cached: Promise<string | null> | null = null;

export function selfFilePath(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

export function selfFileHash(): Promise<string | null> {
  if (cached === null) {
    cached = compute();
  }

  return cached;
}

async function compute(): Promise<string | null> {
  const path = selfFilePath();
  const fs = await nodeFileSystem();

  if (path === null || fs === null) {
    return null;
  }

  const raw = await fs.readFile(path, 16 * 1024 * 1024);

  return raw === null ? null : sha256Hex(raw);
}
