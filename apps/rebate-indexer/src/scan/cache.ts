import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CachedClass, ScanCache } from './types.js';

export function defaultCachePath(): string {
  return join(homedir(), '.ophis', 'scan-cache.json');
}

export async function loadCache(path: string = defaultCachePath()): Promise<ScanCache> {
  const map = new Map<string, CachedClass>();
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, CachedClass>;
    for (const [k, v] of Object.entries(obj)) {
      if (v === 'ophis' || v === 'greg' || v === 'none') map.set(k.toLowerCase(), v);
    }
  } catch {
    // missing or corrupt -> start empty (the scan re-resolves; cache is an optimization)
  }
  return {
    get: (uid) => map.get(uid.toLowerCase()),
    set: (uid, v) => { map.set(uid.toLowerCase(), v); },
    save: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(Object.fromEntries(map)), 'utf8');
    },
  };
}
