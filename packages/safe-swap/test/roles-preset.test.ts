import { describe, expect, it } from 'vitest';
import { getAddress, toFunctionSelector } from 'viem';
import { processPermissions } from 'zodiac-roles-sdk';
import { getOphisSettlementAddress, getOphisVaultRelayer } from '@ophis/sdk';
import { ophisCuratorRolesPreset } from '../src/roles-preset.js';

const CHAIN = 10; // OP
// as `0x${string}`: zodiac-roles-sdk pulls its own viem into the type program, so
// viem's branded Address resolves ambiguously here (see the exec-safe note).
const USDC = getAddress('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85') as `0x${string}`;
const WETH = getAddress('0x4200000000000000000000000000000000000006') as `0x${string}`;
const RELAYER = (getOphisVaultRelayer(CHAIN) as string).toLowerCase();
const OPHIS_SETTLEMENT = (getOphisSettlementAddress(CHAIN) as string).toLowerCase();
const CANONICAL_COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';

const APPROVE = '0x095ea7b3';
const TRANSFER = '0xa9059cbb';
const TRANSFER_FROM = '0x23b872dd';
const SET_PRESIGNATURE = toFunctionSelector('setPreSignature(bytes,bool)');

// BigInt-safe stringify for substring assertions.
const dump = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)).toLowerCase();

describe('ophisCuratorRolesPreset', () => {
  const preset = ophisCuratorRolesPreset({ chainId: CHAIN, sellTokens: [USDC, WETH] });
  const { targets } = processPermissions([preset]);
  const json = dump(targets);
  const byAddress = (a: string) => targets.find((t) => t.address.toLowerCase() === a.toLowerCase());

  it('scopes exactly the two underlyings + the Ophis settlement (default-deny elsewhere)', () => {
    const addrs = targets.map((t) => t.address.toLowerCase()).sort();
    expect(addrs).toEqual([USDC.toLowerCase(), WETH.toLowerCase(), OPHIS_SETTLEMENT].sort());
  });

  it('allows approve ONLY with spender pinned to the Ophis relayer', () => {
    const usdc = byAddress(USDC)!;
    const fn = usdc.functions.find((f) => f.selector.toLowerCase() === APPROVE);
    expect(fn).toBeTruthy();
    expect(fn!.wildcarded).toBe(false); // conditioned, not a blanket approve
    // The relayer address is embedded as the pinned spender compValue.
    expect(dump(fn!.condition)).toContain(RELAYER.slice(2));
    // A foreign spender is NOT baked in anywhere.
    expect(json).not.toContain('dead00000000000000000000000000000000beef');
  });

  it('allows setPreSignature on the Ophis settlement, never canonical CoW', () => {
    const sett = byAddress(OPHIS_SETTLEMENT)!;
    expect(sett.functions.some((f) => f.selector.toLowerCase() === SET_PRESIGNATURE.toLowerCase())).toBe(true);
    expect(byAddress(CANONICAL_COW_SETTLEMENT)).toBeUndefined();
    expect(json).not.toContain(CANONICAL_COW_SETTLEMENT.slice(2));
  });

  it('DENIES transfer / transferFrom on the underlyings (not in the allowlist)', () => {
    for (const token of [USDC, WETH]) {
      const t = byAddress(token)!;
      const selectors = t.functions.map((f) => f.selector.toLowerCase());
      expect(selectors).not.toContain(TRANSFER);
      expect(selectors).not.toContain(TRANSFER_FROM);
      expect(selectors).toEqual([APPROVE]); // ONLY approve is scoped on each token
    }
  });

  it('resolves per chain (Unichain relayer/settlement differ from OP)', () => {
    const uni = ophisCuratorRolesPreset({ chainId: 130, sellTokens: [USDC] });
    const uniJson = dump(processPermissions([uni]).targets);
    expect(uniJson).toContain((getOphisVaultRelayer(130) as string).toLowerCase().slice(2));
    expect(uniJson).not.toContain(RELAYER.slice(2)); // not the OP relayer
  });

  it('rejects an empty token list', () => {
    expect(() => ophisCuratorRolesPreset({ chainId: CHAIN, sellTokens: [] })).toThrow(/at least one sellToken/);
  });
});
