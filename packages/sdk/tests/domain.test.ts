import { describe, it, expect } from 'vitest';
import {
  getOphisSettlementAddress,
  getOphisOrderDomain,
  OPHIS_SETTLEMENT_ADDRESSES,
  getOphisVaultRelayer,
  OPHIS_VAULT_RELAYER_ADDRESSES,
} from '@ophis/sdk';

const CANONICAL = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const OPHIS_OP = '0x310784c7FCE12d578dA6f53460777bAc9718B859';
const CANONICAL_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
const OPHIS_OP_RELAYER = '0x83847EaB41ad9ea43809ce71569eB2e9daF51830';

describe('getOphisSettlementAddress', () => {
  it('returns the Ophis-deployed OP settlement for chain 10, NOT the canonical CoW one', () => {
    expect(getOphisSettlementAddress(10)).toBe(OPHIS_OP);
    expect(getOphisSettlementAddress(10)).not.toBe(CANONICAL);
  });

  it('returns the canonical CoW settlement for CoW-aligned chains', () => {
    expect(getOphisSettlementAddress(1)).toBe(CANONICAL);
    expect(getOphisSettlementAddress(8453)).toBe(CANONICAL);
    expect(getOphisSettlementAddress(100)).toBe(CANONICAL);
  });

  it('mirrors the frontend map for the paused Ophis-operated chains (4326, 999)', () => {
    expect(getOphisSettlementAddress(4326)).toBe(OPHIS_OP); // MegaETH — same as OP
    expect(getOphisSettlementAddress(999)).toBe('0x0864b65F1EFe752a699d119Ae0419E7331a8Bfce'); // HyperEVM
  });

  it('throws on an unsupported / invalid chainId', () => {
    expect(() => getOphisSettlementAddress(12345)).toThrow(/no settlement address/);
    // @ts-expect-error missing arg
    expect(() => getOphisSettlementAddress()).toThrow(/positive integer/);
  });
});

describe('getOphisOrderDomain', () => {
  it('builds the EIP-712 domain with the correct per-chain verifying contract', () => {
    expect(getOphisOrderDomain(10)).toEqual({
      name: 'Gnosis Protocol',
      version: 'v2',
      chainId: 10,
      verifyingContract: OPHIS_OP,
    });
  });

  it('pins chain 10 to the Ophis OP settlement (regression guard vs the hardcoded-canonical bug)', () => {
    const domain = getOphisOrderDomain(10);
    expect(domain.chainId).toBe(10);
    expect(domain.verifyingContract).toBe(OPHIS_OP);
    expect(domain.verifyingContract).not.toBe(CANONICAL);
  });

  it('OPHIS_SETTLEMENT_ADDRESSES is frozen', () => {
    expect(Object.isFrozen(OPHIS_SETTLEMENT_ADDRESSES)).toBe(true);
  });
});

describe('getOphisVaultRelayer', () => {
  it('returns the Ophis OP relayer for chain 10, NOT the canonical CoW relayer (the approval footgun)', () => {
    expect(getOphisVaultRelayer(10)).toBe(OPHIS_OP_RELAYER);
    expect(getOphisVaultRelayer(10)).not.toBe(CANONICAL_RELAYER);
  });

  it('returns the canonical CoW relayer for CoW-hosted chains', () => {
    expect(getOphisVaultRelayer(1)).toBe(CANONICAL_RELAYER);
    expect(getOphisVaultRelayer(8453)).toBe(CANONICAL_RELAYER);
    expect(getOphisVaultRelayer(42161)).toBe(CANONICAL_RELAYER);
  });

  it('covers exactly the same chains as the settlement map (relayer + settlement stay paired)', () => {
    expect(Object.keys(OPHIS_VAULT_RELAYER_ADDRESSES).sort()).toEqual(Object.keys(OPHIS_SETTLEMENT_ADDRESSES).sort());
  });

  it('throws on an unsupported / invalid chainId', () => {
    expect(() => getOphisVaultRelayer(12345)).toThrow(/no vault relayer/);
    // @ts-expect-error missing arg
    expect(() => getOphisVaultRelayer()).toThrow(/positive integer/);
  });

  it('OPHIS_VAULT_RELAYER_ADDRESSES is frozen', () => {
    expect(Object.isFrozen(OPHIS_VAULT_RELAYER_ADDRESSES)).toBe(true);
  });
});
