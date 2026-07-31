import { resolveOphisPartnerFee } from './resolveOphisPartnerFee'

// Stand-ins for the two competing fee shapes. The resolver is generic and never
// inspects the value, so opaque sentinels are enough and keep the test pinned to
// the DECISION rather than to either shape's fields.
const WIDGET_FEE = { source: 'widget-partner-fee' } as const
const VOLUME_FEE = { source: 'volume-fee-pipeline' } as const

// Chains that mandate the CIP-75 Volume policy and reject the price-improvement
// shape at ingress (VOLUME_ONLY_CHAIN_IDS in ophis/partnerFeeDefault).
const VOLUME_ONLY = [10, 130, 4663]
// A CoW-hosted chain, present in the recipient map, where PI passes through.
const HOSTED = 1

describe('resolveOphisPartnerFee', () => {
  it('suppresses the price-improvement shape on every Volume-only chain', () => {
    // Not a downgrade: those chains carry their floor fee on the volumeFee
    // pipeline, so the fallback below is the correct fee, not an absent one.
    for (const chainId of VOLUME_ONLY) {
      expect(resolveOphisPartnerFee(WIDGET_FEE, VOLUME_FEE, chainId)).toBe(VOLUME_FEE)
    }
  })

  it('passes the widget partner fee through on a CoW-hosted chain', () => {
    expect(resolveOphisPartnerFee(WIDGET_FEE, VOLUME_FEE, HOSTED)).toBe(WIDGET_FEE)
  })

  it('falls back to the volume fee when there is no widget override', () => {
    expect(resolveOphisPartnerFee(undefined, VOLUME_FEE, HOSTED)).toBe(VOLUME_FEE)
  })

  it('still yields the volume fee on a Volume-only chain with no widget override', () => {
    // The revenue-critical case: a plain basket on Optimism must not be free.
    expect(resolveOphisPartnerFee(undefined, VOLUME_FEE, 10)).toBe(VOLUME_FEE)
  })

  it('emits no fee when the chain is unknown', () => {
    // No connected wallet. Better to emit nothing than to guess a recipient.
    expect(resolveOphisPartnerFee(WIDGET_FEE, undefined, undefined)).toBeUndefined()
  })

  it('does not invent a fee when both inputs are absent', () => {
    for (const chainId of [...VOLUME_ONLY, HOSTED, undefined]) {
      expect(resolveOphisPartnerFee(undefined, undefined, chainId)).toBeUndefined()
    }
  })

  it('never returns undefined on a supported chain when a volume fee exists', () => {
    // This is the invariant that stops a basket leg shipping fee-free. If it
    // ever fails, every leg of every basket settles at zero Ophis fee.
    for (const chainId of [...VOLUME_ONLY, HOSTED]) {
      for (const widget of [WIDGET_FEE, undefined]) {
        expect(resolveOphisPartnerFee(widget, VOLUME_FEE, chainId)).toBeDefined()
      }
    }
  })
})
