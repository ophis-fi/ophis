import { describe, expect, it } from 'vitest';
import { OPHIS_PARTNER_FEE_RECIPIENT } from '@ophis/sdk';
import {
  withOphisDefaults,
  OPHIS_WIDGET_BASE_URL,
  OPHIS_WIDGET_APP_CODE,
} from '../src/defaults.js';

describe('withOphisDefaults', () => {
  it('injects the Ophis host, appCode and fee recipient', () => {
    const merged = withOphisDefaults({ tradeType: 'swap' } as any);
    expect(merged.baseUrl).toBe(OPHIS_WIDGET_BASE_URL);
    expect(merged.baseUrl).toBe('https://swap.ophis.fi');
    expect(merged.appCode).toBe(OPHIS_WIDGET_APP_CODE);
    expect(merged.partnerFee?.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    expect(merged.partnerFee?.bps).toBe(5);
  });

  it('lets the caller override host, appCode and fee bps', () => {
    const merged = withOphisDefaults({
      tradeType: 'swap',
      baseUrl: 'https://staging.ophis.fi',
      appCode: 'MyDapp-via-Ophis',
      partnerFee: { bps: 5, recipient: '0x000000000000000000000000000000000000dEaD' },
    } as any);
    expect(merged.baseUrl).toBe('https://staging.ophis.fi');
    expect(merged.appCode).toBe('MyDapp-via-Ophis');
    expect(merged.partnerFee?.bps).toBe(5);
  });

  it('treats a blank or whitespace baseUrl/appCode as unset (no silent leak to the CoW host)', () => {
    const blank = withOphisDefaults({ tradeType: 'swap', baseUrl: '', appCode: '   ' } as any);
    expect(blank.baseUrl).toBe('https://swap.ophis.fi');
    expect(blank.appCode).toBe('Ophis');

    const whitespaceUrl = withOphisDefaults({ tradeType: 'swap', baseUrl: '   ' } as any);
    expect(whitespaceUrl.baseUrl).toBe('https://swap.ophis.fi');
  });

  it('always pins the fee recipient to the Ophis Safe (caller cannot redirect it)', () => {
    const merged = withOphisDefaults({
      tradeType: 'swap',
      partnerFee: { bps: 20, recipient: '0x000000000000000000000000000000000000dEaD' },
    } as any);
    expect(merged.partnerFee?.recipient).toBe(OPHIS_PARTNER_FEE_RECIPIENT);
    expect(merged.partnerFee?.recipient).not.toBe('0x000000000000000000000000000000000000dEaD');
  });
});
