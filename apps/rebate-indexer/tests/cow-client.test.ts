import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CowTrade } from '../src/cow/types.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('CowTrade schema', () => {
  it('parses every entry in tests/fixtures/cow-trades.json', () => {
    const data: unknown[] = JSON.parse(readFileSync(join(fixturesDir, 'cow-trades.json'), 'utf8'));
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data) {
      expect(() => CowTrade.parse(entry)).not.toThrow();
    }
  });
});
