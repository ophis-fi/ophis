import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { isBoostedToken, OPHIS_BOOSTED_VOLUME_BPS } from './boostedTokens'

const ALEPH_MAINNET = '0x27702a26126e0B3702af63Ee09aC4d1A084EF628' // checksummed
const USDC_MAINNET = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('isBoostedToken (ALEPH flagship)', () => {
  it('matches ALEPH on mainnet, case-insensitively', () => {
    expect(isBoostedToken(SupportedChainId.MAINNET, ALEPH_MAINNET)).toBe(true)
    expect(isBoostedToken(SupportedChainId.MAINNET, ALEPH_MAINNET.toLowerCase())).toBe(true)
    expect(isBoostedToken(SupportedChainId.MAINNET, ALEPH_MAINNET.toUpperCase())).toBe(true)
  })

  it('does NOT match a non-boosted token (USDC)', () => {
    expect(isBoostedToken(SupportedChainId.MAINNET, USDC_MAINNET)).toBe(false)
  })

  it('does NOT match ALEPH on a chain where it is not configured', () => {
    expect(isBoostedToken(SupportedChainId.BASE, ALEPH_MAINNET)).toBe(false)
  })

  it('handles undefined / empty addresses', () => {
    expect(isBoostedToken(SupportedChainId.MAINNET, undefined)).toBe(false)
    expect(isBoostedToken(SupportedChainId.MAINNET, '')).toBe(false)
  })

  it('boosted rate is 1 bp (the max-rebate rate)', () => {
    expect(OPHIS_BOOSTED_VOLUME_BPS).toBe(1)
  })
})
