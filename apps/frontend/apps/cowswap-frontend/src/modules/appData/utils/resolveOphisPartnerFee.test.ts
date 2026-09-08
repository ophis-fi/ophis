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

  describe('a host widget fee stacks on the Ophis entry instead of replacing it', () => {
    // Real shapes here, because the stacking rule DOES inspect the volume fee.
    const OPHIS_SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
    const OPHIS_SHAPE = [
      { volumeBps: 1, recipient: OPHIS_SAFE },
      { priceImprovementBps: 8000, maxVolumeBps: 99, recipient: OPHIS_SAFE },
    ]
    // mtpelerin's actual override (2026-09-08: 50 bps to itself, 0 to Ophis).
    const HOST_FEE = { volumeBps: 50, recipient: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' }

    it('puts the host fee FIRST, then the Ophis entries, on a CoW-hosted chain', () => {
      // Order is load-bearing: CoW consumes its 100 bps aggregate budget in array
      // order (PI cap counted up front) and the SDK's min-buy math reads the first
      // Volume entry. Host first keeps the host whole and the order fillable.
      expect(resolveOphisPartnerFee(OPHIS_SHAPE, HOST_FEE, HOSTED)).toEqual([HOST_FEE, ...OPHIS_SHAPE])
    })

    it('stacks on the stable-pair variant too (swap happens before the stack)', () => {
      const STABLE_SHAPE = [
        { volumeBps: 1, recipient: OPHIS_SAFE },
        { priceImprovementBps: 5000, maxVolumeBps: 20, recipient: OPHIS_SAFE },
      ]
      // The chain gate swaps by reference equality against the module constant, so
      // pass the stable shape in directly to pin that the stack is built after it.
      expect(resolveOphisPartnerFee(STABLE_SHAPE, HOST_FEE, HOSTED, true)).toEqual([HOST_FEE, ...STABLE_SHAPE])
    })

    it('never appends the Ophis base a second time when it arrives on the volumeFee pipeline', () => {
      // Flat-fee flag on, no host override: volumeFee IS the Ophis 1 bp base,
      // which the Ophis shape already contains (#1236 duplicated-partnerFee class).
      const ophisBase = { volumeBps: 1, recipient: OPHIS_SAFE }
      expect(resolveOphisPartnerFee(OPHIS_SHAPE, ophisBase, HOSTED)).toBe(OPHIS_SHAPE)
      // Recipient casing must not defeat the guard.
      expect(resolveOphisPartnerFee(OPHIS_SHAPE, { ...ophisBase, recipient: OPHIS_SAFE.toLowerCase() }, HOSTED)).toBe(
        OPHIS_SHAPE,
      )
    })

    it('ignores a zero or malformed host fee', () => {
      expect(resolveOphisPartnerFee(OPHIS_SHAPE, { ...HOST_FEE, volumeBps: 0 }, HOSTED)).toBe(OPHIS_SHAPE)
      expect(resolveOphisPartnerFee(OPHIS_SHAPE, { volumeBps: 50 }, HOSTED)).toBe(OPHIS_SHAPE)
    })

    it('still yields only the pipeline fee on a Volume-only chain (PI shape suppressed there)', () => {
      // Unchanged behaviour: the sovereign backend enforces its recipient
      // allowlist at ingress, so a foreign host fee is rejected there anyway.
      for (const chainId of VOLUME_ONLY) {
        expect(resolveOphisPartnerFee(OPHIS_SHAPE, HOST_FEE, chainId)).toBe(HOST_FEE)
      }
    })
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
