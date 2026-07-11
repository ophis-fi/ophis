import { describe, it, expect, beforeEach } from 'vitest';
import { loadAlchemyEnv, loadTelegramEnv } from '../../src/scan/secrets.js';

beforeEach(() => {
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('loadAlchemyEnv', () => {
  it('prefers an already-set env var (no keychain read)', async () => {
    process.env.ALCHEMY_API_KEY = 'ENVKEY';
    let read = 0;
    const k = await loadAlchemyEnv(async () => { read++; return 'KCKEY'; });
    expect(k).toBe('ENVKEY');
    expect(read).toBe(0);
  });
  it('falls back to keychain and populates env', async () => {
    const k = await loadAlchemyEnv(async () => 'KCKEY');
    expect(k).toBe('KCKEY');
    expect(process.env.ALCHEMY_API_KEY).toBe('KCKEY');
  });
  it('throws if no key anywhere', async () => {
    await expect(loadAlchemyEnv(async () => null)).rejects.toThrow();
  });
});

describe('loadTelegramEnv', () => {
  it('sets token + Clement chat id', async () => {
    const ok = await loadTelegramEnv(async () => 'BOTTOKEN');
    expect(ok).toBe(true);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe('BOTTOKEN');
    expect(process.env.TELEGRAM_CHAT_ID).toBe('735726338');
  });
  it('returns false if no token', async () => {
    expect(await loadTelegramEnv(async () => null)).toBe(false);
  });
});
