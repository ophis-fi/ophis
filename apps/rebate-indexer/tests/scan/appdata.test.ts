import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppData } from '../../src/scan/appdata.js';

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

describe('parseAppData', () => {
  it('extracts appCode + feeBps from a real Ophis order', () => {
    const r = parseAppData(fx('mainnet-ophis-order.json'));
    expect(r.appCode).toBe('ophis');
    expect(r.feeBps).toBe(10);
    expect(r.refCode).toBeNull();
  });
  it('rejects a non-Ophis appCode', () => {
    expect(parseAppData(fx('non-ophis-order.json')).appCode).toBeNull();
  });
  it('matches appCode case-insensitively and canonicalises to lower-case', () => {
    // The MCP server emits a capitalised "Ophis"; the scan must still recognise it.
    expect(parseAppData('{"appCode":"Ophis"}').appCode).toBe('ophis');
    expect(parseAppData('{"appCode":"OPHIS"}').appCode).toBe('ophis');
    expect(parseAppData('{"appCode":"Greg"}').appCode).toBe('greg');
    expect(parseAppData('{"appCode":"NotOphis"}').appCode).toBeNull();
  });
  it('keeps a grammar-valid referral code, drops a bad one', () => {
    expect(parseAppData('{"appCode":"ophis","metadata":{"ophisReferrer":{"code":"Friend_01"}}}').refCode).toBe('friend_01');
    expect(parseAppData('{"appCode":"ophis","metadata":{"ophisReferrer":{"code":"a"}}}').refCode).toBeNull();
  });
  it('is null-safe on missing/malformed input', () => {
    expect(parseAppData(null)).toEqual({ appCode: null, refCode: null, feeBps: null });
    expect(parseAppData('{not json')).toEqual({ appCode: null, refCode: null, feeBps: null });
  });
  it('returns empty for JSON that parses to a non-object', () => {
    expect(parseAppData('null')).toEqual({ appCode: null, refCode: null, feeBps: null });
    expect(parseAppData('[]')).toEqual({ appCode: null, refCode: null, feeBps: null });
    expect(parseAppData('"string"')).toEqual({ appCode: null, refCode: null, feeBps: null });
    expect(parseAppData('42')).toEqual({ appCode: null, refCode: null, feeBps: null });
  });
  it('bounds feeBps as a non-negative integer within 0-10000', () => {
    expect(parseAppData('{"appCode":"ophis","metadata":{"partnerFee":{"volumeBps":10}}}').feeBps).toBe(10);
    expect(parseAppData('{"appCode":"ophis","metadata":{"partnerFee":{"volumeBps":-5}}}').feeBps).toBeNull();
    expect(parseAppData('{"appCode":"ophis","metadata":{"partnerFee":{"volumeBps":10.5}}}').feeBps).toBeNull();
  });
});
