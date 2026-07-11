import { describe, it, expect, afterEach } from 'vitest';
import { redactSecrets } from '../../src/scan/redact.js';

// The values below are obviously-fake placeholders, not real credentials.
afterEach(() => {
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('redactSecrets', () => {
  it('strips an Alchemy key from a viem-style RPC error URL', () => {
    const msg = 'HTTP request failed. URL: https://eth-mainnet.g.alchemy.com/v2/FAKEkey_abc-123 Status: 429';
    const out = redactSecrets(msg);
    expect(out).not.toContain('FAKEkey_abc-123');
    expect(out).toContain('g.alchemy.com/v2/***');
  });

  it('strips the exact env secret values wherever they appear (any shape)', () => {
    process.env.ALCHEMY_API_KEY = 'FAKE_env_alchemy_key_xyz';
    process.env.TELEGRAM_BOT_TOKEN = 'FAKE_bot_token_0987654321';
    const out = redactSecrets('boom wss://x/FAKE_env_alchemy_key_xyz and FAKE_bot_token_0987654321 leaked');
    expect(out).not.toContain('FAKE_env_alchemy_key_xyz');
    expect(out).not.toContain('FAKE_bot_token_0987654321');
    expect(out).toContain('***');
  });

  it('strips key/token query params', () => {
    expect(redactSecrets('https://x.com/rpc?apikey=FAKEqueryKey123&x=1')).not.toContain('FAKEqueryKey123');
  });

  it('leaves a clean message untouched', () => {
    expect(redactSecrets('ECONNREFUSED 127.0.0.1:8545')).toBe('ECONNREFUSED 127.0.0.1:8545');
  });
});
