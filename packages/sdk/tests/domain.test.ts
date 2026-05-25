import { describe, it, expect } from 'vitest';
import { getOphisSettlementAddress, getOphisOrderDomain, OPHIS_SETTLEMENT_ADDRESSES } from '@ophis/sdk';

const CANONICAL = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const OPHIS_OP = '0x310784c7FCE12d578dA6f53460777bAc9718B859';

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
