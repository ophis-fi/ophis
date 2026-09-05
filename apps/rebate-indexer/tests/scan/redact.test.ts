import { describe, it, expect, afterEach } from 'vitest';
import { redactSecrets } from '../../src/scan/redact.js';

// The values below are obviously-fake placeholders, not real credentials.
afterEach(() => {
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.SCAN_RPC_ETHEREUM;
  delete process.env.SCAN_BLOCK_RPC_ETHEREUM;
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

  it('redacts a complete per-chain RPC override from provider errors', () => {
    process.env.SCAN_RPC_ETHEREUM = 'https://rpc.example/v1/FAKE_private_path';
    const out = redactSecrets(`request failed at ${process.env.SCAN_RPC_ETHEREUM}`);
    expect(out).toBe('request failed at [configured RPC]');
  });

  it('redacts a separate block RPC override', () => {
    process.env.SCAN_BLOCK_RPC_ETHEREUM = 'https://blocks.example/v1/FAKE_private_path';
    expect(redactSecrets(`bad block at ${process.env.SCAN_BLOCK_RPC_ETHEREUM}`))
      .toBe('bad block at [configured RPC]');
  });

  it('leaves a clean message untouched', () => {
    expect(redactSecrets('ECONNREFUSED 127.0.0.1:8545')).toBe('ECONNREFUSED 127.0.0.1:8545');
  });
});
