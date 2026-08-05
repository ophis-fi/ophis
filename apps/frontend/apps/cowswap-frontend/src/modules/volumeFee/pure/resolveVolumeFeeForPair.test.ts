import { OPHIS_NON_STABLE_VOLUME_BPS, OPHIS_PARTNER_FEE_RECIPIENT, OPHIS_STABLE_VOLUME_BPS } from 'ophis/partnerFeeDefault'

import {
  isBoostedPair,
  isCorrelatedPair,
  isStableStablePair,
  resolveVolumeFeeForPair,
  VolumeFeePair,
} from './resolveVolumeFeeForPair'

// Real addresses, so a token-list edit that breaks these assumptions surfaces
// here instead of in production.
const OP = 10
const MAINNET = 1
const BASE = 8453
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
const USDT_OP = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'
const WETH_OP = '0x4200000000000000000000000000000000000006'
const ALEPH_MAINNET = '0x27702a26126e0b3702af63ee09ac4d1a084ef628'
const ALEPH_BASE = '0xc0fbc4967259786c743361a5885ef49380473dcf'
const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

const pair = (over: Partial<VolumeFeePair> = {}): VolumeFeePair => ({
  chainId: OP,
  sellTokenAddress: USDC_OP,
  buyTokenAddress: WETH_OP,
  ...over,
})

const NO_CONTEXT = { widgetPartnerFee: undefined, safeAppFee: undefined, correlatedTokens: undefined }

describe('isStableStablePair', () => {
  it('is true only when BOTH sides are stablecoins', () => {
    expect(isStableStablePair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }))).toBe(true)
    expect(isStableStablePair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: WETH_OP }))).toBe(false)
    expect(isStableStablePair(pair({ sellTokenAddress: WETH_OP, buyTokenAddress: WETH_OP }))).toBe(false)
  })

  it('ignores address casing', () => {
    expect(
      isStableStablePair(
        pair({ sellTokenAddress: USDC_OP.toUpperCase().replace('0X', '0x'), buyTokenAddress: USDT_OP.toLowerCase() }),
      ),
    ).toBe(true)
  })

  it('is false on an unsupported chain rather than throwing', () => {
    expect(isStableStablePair(pair({ chainId: 999999, sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }))).toBe(
      false,
    )
  })

  it('is false for a cross-chain pair even when both addresses look stable', () => {
    // The bridge intermediate lives on the SELL chain, so it can be in this
    // chain's stablecoin set. Without the cross-chain bail-out a bridge trade
    // would silently take the reduced rate, which the swap path never did.
    expect(
      isStableStablePair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP, isCrossChain: true })),
    ).toBe(false)
  })
})

describe('isBoostedPair', () => {
  it('is true when EITHER side is boosted', () => {
    expect(isBoostedPair(pair({ chainId: MAINNET, sellTokenAddress: ALEPH_MAINNET, buyTokenAddress: WETH_MAINNET }))).toBe(true)
    expect(isBoostedPair(pair({ chainId: MAINNET, sellTokenAddress: WETH_MAINNET, buyTokenAddress: ALEPH_MAINNET }))).toBe(true)
    expect(isBoostedPair(pair({ chainId: MAINNET, sellTokenAddress: WETH_MAINNET, buyTokenAddress: USDC_OP }))).toBe(false)
  })

  it('keys on the chain, so the same token is not boosted everywhere', () => {
    expect(isBoostedPair(pair({ chainId: BASE, sellTokenAddress: ALEPH_BASE, buyTokenAddress: WETH_OP }))).toBe(true)
    // The Base ALEPH address is not the mainnet one, so it must not match on mainnet.
    expect(isBoostedPair(pair({ chainId: MAINNET, sellTokenAddress: ALEPH_BASE, buyTokenAddress: WETH_OP }))).toBe(false)
  })

  it('honours boostedChainId over chainId', () => {
    // The swap path keys the boost on the TRADE's chain while the stablecoin set
    // keys on the WALLET's chain; they differ mid-chain-switch.
    expect(
      isBoostedPair(pair({ chainId: OP, boostedChainId: MAINNET, sellTokenAddress: ALEPH_MAINNET })),
    ).toBe(true)
  })

  it('is false for a cross-chain pair even when the sell token is boosted', () => {
    expect(
      isBoostedPair(pair({ chainId: MAINNET, sellTokenAddress: ALEPH_MAINNET, isCrossChain: true })),
    ).toBe(false)
  })
})

describe('isCorrelatedPair', () => {
  it('matches a two-token correlated list only when both sides are in it', () => {
    const list = [{ [USDC_OP.toLowerCase()]: 'USDC', [USDT_OP.toLowerCase()]: 'USDT' }]
    expect(isCorrelatedPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }), list)).toBe(true)
    expect(isCorrelatedPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: WETH_OP }), list)).toBe(false)
  })

  it('is false when the correlated lists have not loaded', () => {
    expect(isCorrelatedPair(pair(), undefined)).toBe(false)
  })
})

describe('resolveVolumeFeeForPair', () => {
  // OPHIS_FLAT_VOLUME_FEE_ENABLED is derived from an env var that is unset under
  // test, so these exercise the flag-OFF path: the Volume-only chain floor. That
  // is the production configuration on every sovereign chain, and the one a
  // basket leg actually takes.

  it('emits the Volume-only floor on each sovereign chain', () => {
    for (const chainId of [10, 130, 4663]) {
      expect(resolveVolumeFeeForPair(pair({ chainId }), NO_CONTEXT)).toEqual({
        volumeBps: OPHIS_NON_STABLE_VOLUME_BPS,
        recipient: OPHIS_PARTNER_FEE_RECIPIENT,
      })
    }
  })

  it('emits the reduced floor for a stable-to-stable pair', () => {
    expect(
      resolveVolumeFeeForPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }), NO_CONTEXT),
    ).toEqual({ volumeBps: OPHIS_STABLE_VOLUME_BPS, recipient: OPHIS_PARTNER_FEE_RECIPIENT })
  })

  it('uses the same 1 bp sovereign base for stable and volatile basket legs', () => {
    // This is the regression the per-leg wiring exists to prevent. Resolving
    // once from the swap form and reusing it would give both legs whichever of
    // these two answers the form happened to hold.
    const stableLeg = resolveVolumeFeeForPair(
      pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }),
      NO_CONTEXT,
    )
    const volatileLeg = resolveVolumeFeeForPair(
      pair({ sellTokenAddress: USDC_OP, buyTokenAddress: WETH_OP }),
      NO_CONTEXT,
    )

    expect(stableLeg?.volumeBps).toBe(OPHIS_STABLE_VOLUME_BPS)
    expect(volatileLeg?.volumeBps).toBe(OPHIS_NON_STABLE_VOLUME_BPS)
    expect(stableLeg?.volumeBps).toBe(volatileLeg?.volumeBps)
  })

  it('emits no fee on a CoW-hosted chain when nothing else applies', () => {
    // No Volume-only floor off the sovereign chains, and the appData
    // price-improvement shape carries the fee there instead.
    expect(resolveVolumeFeeForPair(pair({ chainId: MAINNET, sellTokenAddress: WETH_MAINNET }), NO_CONTEXT)).toBeUndefined()
  })

  it('exempts a correlated pair, and the floor does not force a fee back on', () => {
    const list = [{ [USDC_OP.toLowerCase()]: 'USDC', [USDT_OP.toLowerCase()]: 'USDT' }]
    expect(
      resolveVolumeFeeForPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }), {
        ...NO_CONTEXT,
        correlatedTokens: list,
      }),
    ).toBeUndefined()
  })

  it("lets a host integrator's own partnerFee override the correlated exemption", () => {
    const integratorFee = { volumeBps: 25, recipient: '0x000000000000000000000000000000000000dEaD' }
    const list = [{ [USDC_OP.toLowerCase()]: 'USDC', [USDT_OP.toLowerCase()]: 'USDT' }]
    expect(
      resolveVolumeFeeForPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }), {
        ...NO_CONTEXT,
        widgetPartnerFee: integratorFee,
        correlatedTokens: list,
      }),
    ).toEqual(integratorFee)
  })

  it("never rewrites an integrator's own fee to an Ophis rate", () => {
    // The reduced-rate branches must only ever touch Ophis's own fee.
    const integratorFee = { volumeBps: 25, recipient: '0x000000000000000000000000000000000000dEaD' }
    expect(
      resolveVolumeFeeForPair(pair({ sellTokenAddress: USDC_OP, buyTokenAddress: USDT_OP }), {
        ...NO_CONTEXT,
        widgetPartnerFee: integratorFee,
      }),
    ).toEqual(integratorFee)
  })

  it('accepts the safeAppFeeAtom null and never returns null', () => {
    const result = resolveVolumeFeeForPair(pair({ chainId: MAINNET, sellTokenAddress: WETH_MAINNET }), {
      ...NO_CONTEXT,
      safeAppFee: null,
    })
    expect(result).toBeUndefined()
    expect(result).not.toBeNull()
  })

  it('uses the Safe App fee off the sovereign chains when there is no widget fee', () => {
    const safeAppFee = { volumeBps: 35, recipient: '0x000000000000000000000000000000000000bEEF' }
    expect(
      resolveVolumeFeeForPair(pair({ chainId: MAINNET, sellTokenAddress: WETH_MAINNET }), {
        ...NO_CONTEXT,
        safeAppFee,
      }),
    ).toEqual(safeAppFee)
  })
})
