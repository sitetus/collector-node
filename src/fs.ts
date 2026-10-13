/**
 * Guarded filesystem access. Static hosts and edge runtimes may not ship
 * `node:fs`; every read goes through here, fails soft, and is capped.
 */
export const MAX_LOCK_BYTES = 8 * 1024 * 1024;

export const MAX_SMALL_FILE_BYTES = 64 * 1024;

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
}

export interface FileSystem {
  readFile(path: string, maxBytes: number): Promise<Buffer | null>;
  stat(path: string): Promise<FileStat | null>;
  readdir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }> | null>;
  writeFile(path: string, data: string): Promise<boolean>;
}

let cached: Promise<FileSystem | null> | null = null;

export function nodeFileSystem(): Promise<FileSystem | null> {
  if (cached === null) {
    cached = load();
  }

  return cached;
}

/** Test seam: replace or reset the filesystem the inventory sees. */
export function useFileSystem(fs: FileSystem | null | undefined): void {
  cached = fs === undefined ? null : Promise.resolve(fs);
}

async function load(): Promise<FileSystem | null> {
  try {
    const fs = await import('node:fs/promises');

    return {
      async readFile(path, maxBytes) {
        try {
          const handle = await fs.open(path, 'r');

          try {
            const { size } = await handle.stat();

            if (size > maxBytes) {
              return null;
            }

            const buffer = Buffer.alloc(size);
            const { bytesRead } = await handle.read(buffer, 0, size, 0);

            return buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      },
      async stat(path) {
        try {
          const stat = await fs.stat(path);

          return { isFile: stat.isFile(), isDirectory: stat.isDirectory(), size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      },
      async readdir(path) {
        try {
          const entries = await fs.readdir(path, { withFileTypes: true });

          return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }));
        } catch {
          return null;
        }
      },
      async writeFile(path, data) {
        try {
          await fs.writeFile(path, data, 'utf8');

          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return null;
  }
}

export async function readJson(fs: FileSystem, path: string, maxBytes: number): Promise<unknown | null> {
  const raw = await fs.readFile(path, maxBytes);

  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

export async function isFile(fs: FileSystem, path: string): Promise<boolean> {
  return (await fs.stat(path))?.isFile === true;
}

export async function isDirectory(fs: FileSystem, path: string): Promise<boolean> {
  return (await fs.stat(path))?.isDirectory === true;
}
