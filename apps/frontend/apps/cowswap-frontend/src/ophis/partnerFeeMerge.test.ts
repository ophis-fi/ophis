import { setGlobalAdapter } from '@cowprotocol/cow-sdk'
import { mergeAppDataDoc } from '@cowprotocol/sdk-trading'

import { OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_PARTNER_FEE_RECIPIENT } from './partnerFeeDefault'

/**
 * Guards the SDK patch in `apps/frontend/patches/@cowprotocol__sdk-trading@2.0.2.patch`.
 *
 * `mergeAppDataDoc` merges with `deepmerge`, whose default array strategy is
 * CONCATENATION. Every trade flow hands the SDK the same appData doc back as an
 * `advancedSettings.appData` override, so the merge is `merge(doc, doc)` and every
 * ARRAY under `metadata` doubles. Upstream never noticed because CoW's own
 * `partnerFee` is a single object; ours is the CIP-75 pair (1 bp Volume + capped
 * PriceImprovement), so from 2026-08-11 (#1174) every order shipped the pair twice
 * (same-chain, one merge) or four times (bridge, two merges).
 *
 * That is not cosmetic. The protocol charges EVERY duplicate — confirmed in
 * `executedProtocolFees` on settled trades — while the SDK sizes the order's buy
 * limit from `getPartnerFeeBps`, which returns the FIRST `volumeBps` it finds (1).
 * Limit priced for 1 bp, settlement charging 4: on 2026-08-24 a Gnosis→BNB bridge
 * order missed its own limit by 2.3 bps and expired unfilled.
 *
 * The patch resets `partnerFee` before the merge exactly as upstream already resets
 * `hooks` and `userConsents`, so an override that supplies one REPLACES it. These
 * tests fail on the unpatched SDK, so a version bump that drops the patch is loud.
 */

// mergeAppDataDoc hashes the merged doc, which needs a global adapter. Only
// keccak256/toUtf8Bytes are touched, so a stub keeps this test free of viem.
const stubAdapter = {
  utils: {
    toUtf8Bytes: (value: string) => value,
    keccak256: () => `0x${'0'.repeat(64)}`,
  },
} as unknown as Parameters<typeof setGlobalAdapter>[0]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clone = <T>(value: T): any => JSON.parse(JSON.stringify(value))

const HOSTED_CHAIN_DOC = {
  version: '1.14.0',
  appCode: 'ophis',
  metadata: {
    partnerFee: OPHIS_DEFAULT_APP_DATA_PARTNER_FEE,
    quote: { slippageBips: 50 },
  },
}

// Ophis-operated chains (OP/Unichain/Robinhood) carry the single-object Volume
// shape instead of the pair; the reset must leave that shape intact too.
const OPERATED_CHAIN_DOC = {
  version: '1.14.0',
  appCode: 'ophis',
  metadata: {
    partnerFee: { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
    quote: { slippageBips: 50 },
  },
}

describe('appData partnerFee survives an SDK merge without duplicating', () => {
  beforeAll(() => {
    setGlobalAdapter(stubAdapter)
  })

  it('same-chain order: one self-merge keeps the pair at 2 entries', async () => {
    const merged = await mergeAppDataDoc(clone(HOSTED_CHAIN_DOC), clone(HOSTED_CHAIN_DOC))

    expect(merged.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
  })

  it('bridge order: the quote-time merge plus the post-time merge still keeps 2 entries', async () => {
    const afterQuote = await mergeAppDataDoc(clone(HOSTED_CHAIN_DOC), clone(HOSTED_CHAIN_DOC))
    const afterPost = await mergeAppDataDoc(clone(afterQuote.doc), clone(afterQuote.doc))

    expect(afterPost.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
  })

  it('an override that carries no partnerFee leaves the doc fee untouched', async () => {
    // This is the bridging SDK's second merge: it adds only `metadata.bridging`.
    // The reset must be conditional, or it would silently strip the fee here.
    const merged = await mergeAppDataDoc(clone(HOSTED_CHAIN_DOC), {
      metadata: { bridging: { destinationChainId: '56' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    expect(merged.doc.metadata.partnerFee).toEqual(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
  })

  it('operated-chain single-object Volume shape survives a self-merge unchanged', async () => {
    const merged = await mergeAppDataDoc(clone(OPERATED_CHAIN_DOC), clone(OPERATED_CHAIN_DOC))

    expect(merged.doc.metadata.partnerFee).toEqual(OPERATED_CHAIN_DOC.metadata.partnerFee)
  })
})
