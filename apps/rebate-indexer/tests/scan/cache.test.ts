import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadCache } from '../../src/scan/cache.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'scan-')), 'c.json');

describe('loadCache', () => {
  it('round-trips entries', async () => {
    const p = tmp();
    const c = await loadCache(p);
    c.set('0xaaa', 'ophis');
    c.set('0xbbb', 'none');
    await c.save();
    const c2 = await loadCache(p);
    expect(c2.get('0xaaa')).toBe('ophis');
    expect(c2.get('0xbbb')).toBe('none');
    expect(c2.get('0xccc')).toBeUndefined();
  });
  it('normalises keys to lower-case across get/set/save', async () => {
    const p = tmp();
    const c = await loadCache(p);
    c.set('0xAAA', 'ophis');
    expect(c.get('0xaaa')).toBe('ophis');
    expect(c.get('0xAAA')).toBe('ophis');
    await c.save();
    const c2 = await loadCache(p);
    expect(c2.get('0xAAA')).toBe('ophis');
  });
  it('treats a missing file as empty', async () => {
    const c = await loadCache(join(tmpdir(), 'does-not-exist-12345', 'c.json'));
    expect(c.get('0xaaa')).toBeUndefined();
  });
  it('treats a corrupt file as empty', async () => {
    const p = tmp();
    writeFileSync(p, '{not json');
    const c = await loadCache(p);
    expect(c.get('0xaaa')).toBeUndefined();
  });
  it('writes the cache with owner-only (0600) permissions and leaves no temp file', async () => {
    const p = tmp();
    const c = await loadCache(p);
    c.set('0xaaa', 'ophis');
    await c.save();
    // file is owner-only (mask off the type bits)
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // the atomic rename leaves no .tmp turds behind in the target dir
    expect(readdirSync(dirname(p)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
