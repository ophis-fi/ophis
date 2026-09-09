import { setGlobalAdapter } from '@cowprotocol/cow-sdk'
import { getQuoteAmountsAndCosts, OrderKind } from '@cowprotocol/sdk-order-book'
import { buildAppData, getPartnerFeeBps, mergeAppDataDoc } from '@cowprotocol/sdk-trading'

import { OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_PARTNER_FEE_RECIPIENT } from './partnerFeeDefault'

/**
 * Guards the SDK patch in `apps/frontend/patches/@cowprotocol__sdk-trading@2.0.2.patch`.
 *
 * The SDK merges appData with `deepmerge`, whose default array strategy is
 * CONCATENATION, and every trade flow hands it the same doc back as an
 * `advancedSettings.appData` override. The merge is therefore `merge(doc, doc)` and
 * every ARRAY under `metadata` doubles. Upstream never noticed because CoW's own
 * `partnerFee` is a single object; ours is the CIP-75 pair (1 bp Volume + capped
 * PriceImprovement), so from 2026-08-11 (#1174) orders shipped it twice or more.
 *
 * There are TWO merge sites, and they need separate covering:
 *   - `mergeAppDataDoc`, used by `postSwapOrderFromQuote` and by the bridging SDK at
 *     quote time. Swaps doubled to 4 entries, bridges to 8.
 *   - `buildAppData`, used by `postLimitOrder`. `applySettingsToLimitTradeParameters`
 *     copies the override's `partnerFee` into params FIRST, so base and override carry
 *     the same array and it doubles to 4 there too.
 *
 * Not cosmetic: the protocol charges EVERY duplicate, confirmed in
 * `executedProtocolFees` on settled trades. On the swap path the SDK also sizes the
 * buy limit from `getPartnerFeeBps`, which returns the FIRST `volumeBps` it finds (1),
 * so the limit is priced for 1 bp while settlement charges 4 - on 2026-08-24 a Gnosis
 * to BNB bridge order missed its own limit by 2.3 bps and expired unfilled.
 *
 * The patch resets the array before each merge exactly as upstream already resets
 * `hooks` and `userConsents`, so an override that supplies one REPLACES it. These
 * tests fail on the unpatched SDK, so a bump that drops the patch is loud.
 */

type AppDataDoc = Parameters<typeof mergeAppDataDoc>[0]
type AppDataOverride = Parameters<typeof mergeAppDataDoc>[1]
type BuildParams = Parameters<typeof buildAppData>[0]
type PartnerFeeMetadata = NonNullable<AppDataDoc['metadata']['partnerFee']>
type ProviderAdapter = Parameters<typeof setGlobalAdapter>[0]

// Both SDK functions hash the resulting doc, which needs a global adapter. Only
// keccak256/toUtf8Bytes are reached, so a test double keeps this suite free of
// viem/ethers. The cast is the usual partial-double cast, not an `any` escape:
// every fixture below stays fully typed.
const stubAdapter = {
  utils: {
    toUtf8Bytes: (value: string): string => value,
    keccak256: (): string => `0x${'0'.repeat(64)}`,
  },
} as unknown as ProviderAdapter

// Factories, not shared constants: each merge gets its own object graph, the way
// two successive SDK merges see two structurally equal docs in production.
function partnerFeePair(): PartnerFeeMetadata {
  return OPHIS_DEFAULT_APP_DATA_PARTNER_FEE.map((fee) => ({ ...fee }))
}

function hostedChainDoc(): AppDataDoc {
  return {
    version: '1.14.0',
    appCode: 'ophis',
    metadata: { partnerFee: partnerFeePair(), quote: { slippageBips: 50 } },
  }
}

// Ophis-operated chains (OP/Unichain/Robinhood) carry the single-object Volume
// shape instead of the pair; the reset must leave that shape intact too.
function operatedChainFee(): PartnerFeeMetadata {
  return { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT }
}

function operatedChainDoc(): AppDataDoc {
  return {
    version: '1.14.0',
    appCode: 'ophis',
    metadata: { partnerFee: operatedChainFee(), quote: { slippageBips: 50 } },
  }
}

// The bridging SDK's second merge adds only `metadata.bridging`. Every reset must be
// conditional, or it would silently strip the fee on this shape.
function bridgingOnlyOverride(): AppDataOverride {
  return {
    metadata: {
      bridging: {
        providerId: 'cow-sdk://bridging/providers/near-intents',
        destinationChainId: '56',
        destinationTokenAddress: '0x55d398326f99059fF775485246999027B3197955',
      },
    },
  }
}

function limitOrderParams(partnerFee: PartnerFeeMetadata): BuildParams {
  return { slippageBps: 0, orderClass: 'limit', appCode: 'ophis', partnerFee }
}

describe('appData partnerFee survives an SDK merge without duplicating', () => {
  beforeAll(() => {
    setGlobalAdapter(stubAdapter)
  })

  describe('mergeAppDataDoc: swap and bridge posting', () => {
    it('same-chain order: one self-merge keeps the pair at 2 entries', async () => {
      const merged = await mergeAppDataDoc(hostedChainDoc(), hostedChainDoc())

      expect(merged.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })

    it('bridge order: the quote-time merge plus the post-time merge still keeps 2 entries', async () => {
      const afterQuote = await mergeAppDataDoc(hostedChainDoc(), hostedChainDoc())
      const afterPost = await mergeAppDataDoc(afterQuote.doc, afterQuote.doc)

      expect(afterPost.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })

    it('an override that carries no partnerFee leaves the doc fee untouched', async () => {
      const merged = await mergeAppDataDoc(hostedChainDoc(), bridgingOnlyOverride())

      expect(merged.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })

    it('operated-chain single-object Volume shape survives a self-merge unchanged', async () => {
      const merged = await mergeAppDataDoc(operatedChainDoc(), operatedChainDoc())

      expect(merged.doc.metadata.partnerFee).toEqual(operatedChainFee())
    })

    it('metadata.wrappers is the other array under metadata and must not double either', async () => {
      const wrappers = [{ address: '0x0000000000000000000000000000000000000001' }]
      const doc: AppDataDoc = { version: '1.14.0', appCode: 'ophis', metadata: { wrappers } }

      const merged = await mergeAppDataDoc(doc, { metadata: { wrappers: [...wrappers] } })

      expect(merged.doc.metadata.wrappers).toEqual(wrappers)
    })
  })

  describe('buildAppData: limit-order posting', () => {
    it('does not double the pair that postLimitOrder copies into params', async () => {
      const built = await buildAppData(limitOrderParams(partnerFeePair()), hostedChainDoc())

      expect(built.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })

    it('keeps the params fee when the override carries none', async () => {
      const built = await buildAppData(limitOrderParams(partnerFeePair()), bridgingOnlyOverride())

      expect(built.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })

    it('lets the override win over a differently shaped params fee', async () => {
      const built = await buildAppData(limitOrderParams(operatedChainFee()), hostedChainDoc())

      expect(built.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
    })
  })

  describe('getPartnerFeeBps (patched): the buy limit is sized from EVERY flat Volume entry', () => {
    // A host widget fee is stacked with the 1 bp Ophis base and settlement charges
    // both. Upstream returns the FIRST volumeBps, which signed the order 1 bp too
    // optimistic on every stacked widget order (the same class as the 2.3 bps bridge
    // expiry above). The patch compounds them and rounds up to integer bps; this fails on the unpatched SDK.
    const HOST = '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4'
    it('compounds the host fee and the Ophis base, rounds up, and ignores price improvement', () => {
      expect(
        getPartnerFeeBps([
          { volumeBps: 50, recipient: HOST },
          { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
          { priceImprovementBps: 8000, maxVolumeBps: 99, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
        ]),
      ).toBe(52)
    })
    it.each([
      [[1, 50], 52],
      [[50, 1, 1], 53],
      [[0, 50], 50],
      [[0, 0], 0],
      [[1], 1],
      [[1000, 1000], 2100],
    ])('compounds %j without rounding individual fees', (fees, expected) => {
      expect(getPartnerFeeBps(fees.map((volumeBps) => ({ volumeBps, recipient: HOST })))).toBe(expected)
    })
    it('covers the compounded spend of a zero-slippage BUY order', () => {
      const { amountsToSign } = getQuoteAmountsAndCosts({
        orderParams: {
          kind: OrderKind.BUY,
          sellAmount: '100000000',
          buyAmount: '100000000',
          feeAmount: '0',
          sellToken: HOST,
          buyToken: OPHIS_PARTNER_FEE_RECIPIENT,
          validTo: 2000000000,
          appData: `0x${'0'.repeat(64)}`,
          partiallyFillable: false,
        },
        partnerFeeBps: getPartnerFeeBps([
          { volumeBps: 50, recipient: HOST },
          { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
        ]),
        protocolFeeBps: undefined,
        slippagePercentBps: 0,
      })
      // Driver BUY fees apply successively to the sell amount including previous fees.
      // Plain 51 bps allows 100510000, below the required 100510050.
      expect(BigInt(amountsToSign.sellAmount)).toBeGreaterThanOrEqual(100510050n)
      expect(BigInt(amountsToSign.buyAmount)).toBe(100000000n)
    })
    it('keeps the single-object and PI-only readings', () => {
      expect(getPartnerFeeBps({ volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT })).toBe(1)
      expect(
        getPartnerFeeBps([{ priceImprovementBps: 8000, maxVolumeBps: 99, recipient: OPHIS_PARTNER_FEE_RECIPIENT }]),
      ).toBeUndefined()
      expect(getPartnerFeeBps(undefined)).toBeUndefined()
    })
  })
})
