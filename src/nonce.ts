import type { NonceStore } from './types.js';
import { SKEW_SECONDS } from './verify.js';

/**
 * Nonce stores: a nonce is kept for twice the clock-skew tolerance
 * so a request whose timestamp is still acceptable can never be replayed
 * after its nonce was pruned; the store holds the most recent 1000 entries.
 */
export const WINDOW_SECONDS = 2 * SKEW_SECONDS;

export const MAX_ENTRIES = 1000;

interface StoreData {
  last_valid: number | null;
  nonces: Record<string, number>;
}

function prune(nonces: Map<string, number>, now: number): void {
  for (const [nonce, seenAt] of nonces) {
    if (seenAt < now - WINDOW_SECONDS) {
      nonces.delete(nonce);
    }
  }

  while (nonces.size > MAX_ENTRIES) {
    const oldest = nonces.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    nonces.delete(oldest);
  }
}

/**
 * In-process store. It cannot see other instances (cluster, serverless,
 * several containers): replay across instances is left to the timestamp
 * window the panel and the verifier enforce. The 90-day sleep rule needs a
 * persisted last-valid time, so it is not applicable here.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();

  register(nonce: string, now: number): boolean {
    prune(this.nonces, now);

    if (this.nonces.has(nonce)) {
      return false;
    }

    this.nonces.set(nonce, now);
    prune(this.nonces, now);

    return true;
  }

  lastValidRequestAt(): null {
    return null;
  }

  size(): number {
    return this.nonces.size;
  }
}

/**
 * File store with the PHP collector's JSON layout ({last_valid, nonces}).
 * Writes go to a temp file and are renamed into place; Node has no flock,
 * so concurrent writers are serialized per process only.
 */
export class FileNonceStore implements NonceStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async register(nonce: string, now: number): Promise<boolean | null> {
    const run = this.chain.then(
      () => this.registerSerialized(nonce, now),
      () => this.registerSerialized(nonce, now),
    );
    this.chain = run.catch(() => null);

    return run;
  }

  async lastValidRequestAt(): Promise<number | null> {
    const data = await this.read();

    return data !== null && typeof data.last_valid === 'number' ? data.last_valid : null;
  }

  private async registerSerialized(nonce: string, now: number): Promise<boolean | null> {
    let fs: typeof import('node:fs/promises');

    try {
      fs = await import('node:fs/promises');
    } catch {
      return null;
    }

    const data = (await this.read()) ?? { last_valid: null, nonces: {} };
    const nonces = new Map<string, number>(
      Object.entries(data.nonces).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );

    prune(nonces, now);

    if (nonces.has(nonce)) {
      return false;
    }

    nonces.set(nonce, now);
    prune(nonces, now);

    const next: StoreData = { last_valid: now, nonces: Object.fromEntries(nonces) };
    const temp = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;

    try {
      await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temp, this.path);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);

      return null;
    }

    return true;
  }

  private async read(): Promise<StoreData | null> {
    try {
      const fs = await import('node:fs/promises');
      const handle = await fs.open(this.path, 'r');

      try {
        const { size } = await handle.stat();
        const buffer = Buffer.alloc(Math.min(size, 262_144));
        await handle.read(buffer, 0, buffer.length, 0);
        const parsed: unknown = JSON.parse(buffer.toString('utf8'));

        if (typeof parsed !== 'object' || parsed === null) {
          return null;
        }

        const record = parsed as Partial<StoreData>;

        return {
          last_valid: typeof record.last_valid === 'number' ? record.last_valid : null,
          nonces: typeof record.nonces === 'object' && record.nonces !== null ? record.nonces : {},
        };
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
}
