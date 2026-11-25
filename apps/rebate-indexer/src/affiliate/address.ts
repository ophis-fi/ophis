import { base58 } from '@scure/base';

export function parseAffiliateWallet(value: unknown) {
  if (typeof value !== 'string') return;
  if (value.length === 42 && /^0x[0-9a-f]{40}$/i.test(value)) {
    return { address: value.toLowerCase(), bytes: Buffer.from(value.slice(2), 'hex') };
  }
  if (value.length < 32 || value.length > 44 || /[^1-9A-HJ-NP-Za-km-z]/.test(value)) return;
  const bytes = Buffer.from(base58.decode(value));
  if (bytes.length === 32) return { address: value, bytes };
}

export function formatAffiliateWallet(bytes: Buffer): string {
  if (bytes.length === 32) return base58.encode(bytes);
  if (bytes.length === 20) return '0x' + bytes.toString('hex');
  throw new Error('Invalid affiliate wallet length');
}
