import { createStore } from 'jotai'

import { OPHIS_DEFAULT_APP_DATA_PARTNER_FEE, OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import {
  injectedWidgetAppDataPartnerFeeAtom,
  injectedWidgetHostFeeKindAtom,
  injectedWidgetParamsAtom,
} from './injectedWidgetParamsAtom'

describe('injectedWidgetAppDataPartnerFeeAtom', () => {
  it('applies the complete default policy when no widget override is present', () => {
    const store = createStore()
    expect(store.get(injectedWidgetAppDataPartnerFeeAtom)).toBeDefined()
  })

  it('keeps the Ophis policy when a host widget sets its own partnerFee (the override stacks, it does not replace)', () => {
    // The host's fee reaches the order through the volumeFee pipeline and is
    // appended by resolveOphisPartnerFee; the Ophis entry must survive here.
    const store = createStore()
    store.set(injectedWidgetParamsAtom, {
      params: { partnerFee: { bps: 50, recipient: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' } },
      errors: {},
    })
    expect(store.get(injectedWidgetAppDataPartnerFeeAtom)).toBe(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
  })

  it('is unaffected by an override that names the canonical recipient', () => {
    const store = createStore()
    store.set(injectedWidgetParamsAtom, {
      params: { partnerFee: { bps: 0, recipient: OPHIS_PARTNER_FEE_RECIPIENT } },
      errors: {},
    })
    expect(store.get(injectedWidgetAppDataPartnerFeeAtom)).toBe(OPHIS_DEFAULT_APP_DATA_PARTNER_FEE)
  })
})

describe('injectedWidgetHostFeeKindAtom', () => {
  it('is undefined without a host partnerFee, third-party for a foreign recipient, ophis for the wrapper', () => {
    const store = createStore()
    expect(store.get(injectedWidgetHostFeeKindAtom)).toBeUndefined()
    store.set(injectedWidgetParamsAtom, {
      params: { partnerFee: { bps: 50, recipient: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' } },
      errors: {},
    })
    expect(store.get(injectedWidgetHostFeeKindAtom)).toBe('third-party')
    store.set(injectedWidgetParamsAtom, {
      params: { partnerFee: { bps: 0, recipient: OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase() } },
      errors: {},
    })
    expect(store.get(injectedWidgetHostFeeKindAtom)).toBe('ophis')
    // A per-network map mixing the two counts as third-party (the stacking side).
    store.set(injectedWidgetParamsAtom, {
      params: {
        partnerFee: {
          bps: 50,
          recipient: { 1: OPHIS_PARTNER_FEE_RECIPIENT, 100: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' },
        },
      },
      errors: {},
    })
    expect(store.get(injectedWidgetHostFeeKindAtom)).toBe('third-party')
  })
})
