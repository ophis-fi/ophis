import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CACHED_CLASSES } from './types.js';
import type { CachedClass, ScanCache } from './types.js';

// The cache lives under an APP-CONTROLLED, user-owned directory (~/.ophis), NOT
// the world-writable OS temp dir with a predictable name. A predictable
// os.tmpdir() path lets a local attacker pre-create / symlink the file and
// either read its contents or redirect our write (CodeQL: "Insecure creation of
// file in the os temp dir"). ~/.ophis is created with restrictive perms below.
export function defaultCachePath(): string {
  return join(homedir(), '.ophis', 'scan-cache.json');
}

export async function loadCache(path: string = defaultCachePath()): Promise<ScanCache> {
  const map = new Map<string, CachedClass>();
  try {
    const raw = await readFile(path, 'utf8');
    const obj = JSON.parse(raw) as Record<string, CachedClass>;
    for (const [k, v] of Object.entries(obj)) {
      // Validate against CACHED_CLASSES (single source of truth in types.ts) so a
      // future APP_CODES addition doesn't silently drop valid cached entries.
      if ((CACHED_CLASSES as readonly string[]).includes(v)) map.set(k.toLowerCase(), v as CachedClass);
    }
  } catch {
    // missing or corrupt -> start empty (the scan re-resolves; cache is an optimization)
  }
  return {
    get: (uid) => map.get(uid.toLowerCase()),
    set: (uid, v) => { map.set(uid.toLowerCase(), v); },
    // Atomic, restrictive-permission write:
    //  - the containing dir and file are created mode 0700/0600 (owner-only), so
    //    a co-located user can neither read the cache nor pre-create the target;
    //  - we write to a UNIQUE temp file in the SAME directory (so the final
    //    rename is atomic on the same filesystem) then rename over the target,
    //    so a reader never observes a half-written file and there is no
    //    predictable name to race.
    save: async () => {
      const dir = dirname(path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.scan-cache.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
      const data = JSON.stringify(Object.fromEntries(map));
      try {
        await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, path);
      } catch (err) {
        // Best-effort cleanup of the temp file; the cache is an optimization so a
        // failed save must not crash the scan.
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },
  };
}
