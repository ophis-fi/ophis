import { shouldEmitOphisPartnerFee } from './shouldEmitOphisPartnerFee'

describe('shouldEmitOphisPartnerFee', () => {
  it('returns true for Ophis-operated chains (10/4326/999)', () => {
    expect(shouldEmitOphisPartnerFee(10)).toBe(true) // Optimism mainnet
    expect(shouldEmitOphisPartnerFee(4326)).toBe(true) // MegaETH mainnet
    expect(shouldEmitOphisPartnerFee(999)).toBe(true) // HyperEVM mainnet
  })

  it('returns true for all CoW-supported chains (restored all-chain fee model 2026-05-27)', () => {
    // Ophis earns the partner fee on every chain it serves. Canonical CoW
    // chains settle via api.cow.fi + CoW solvers (CoW disburses 75% weekly).
    // The prior Phase-3 H3 gate wrongly excluded these — an over-correction
    // that cut canonical-chain revenue.
    expect(shouldEmitOphisPartnerFee(1)).toBe(true) // Ethereum
    expect(shouldEmitOphisPartnerFee(100)).toBe(true) // Gnosis Chain
    expect(shouldEmitOphisPartnerFee(8453)).toBe(true) // Base
    expect(shouldEmitOphisPartnerFee(42161)).toBe(true) // Arbitrum One
    expect(shouldEmitOphisPartnerFee(137)).toBe(true) // Polygon
  })

  it('returns false for undefined chainId (wallet disconnected)', () => {
    expect(shouldEmitOphisPartnerFee(undefined)).toBe(false)
  })

  it('returns false for chains absent from the per-network map (unsupported)', () => {
    // Chains the frontend doesn't serve have no map entry → no fee emitted.
    expect(shouldEmitOphisPartnerFee(11)).toBe(false)
    expect(shouldEmitOphisPartnerFee(999_999)).toBe(false)
  })
})
