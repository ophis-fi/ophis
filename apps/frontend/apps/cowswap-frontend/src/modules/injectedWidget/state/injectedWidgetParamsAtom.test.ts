import { createStore } from 'jotai'

import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { injectedWidgetAppDataPartnerFeeAtom, injectedWidgetParamsAtom } from './injectedWidgetParamsAtom'

describe('injectedWidgetAppDataPartnerFeeAtom', () => {
  it('applies the complete default policy when no widget override is present', () => {
    const store = createStore()
    expect(store.get(injectedWidgetAppDataPartnerFeeAtom)).toBeDefined()
  })

  it('honors every explicit override, including one using the canonical recipient', () => {
    const store = createStore()
    store.set(injectedWidgetParamsAtom, {
      params: { partnerFee: { bps: 0, recipient: OPHIS_PARTNER_FEE_RECIPIENT } },
      errors: {},
    })
    expect(store.get(injectedWidgetAppDataPartnerFeeAtom)).toBeUndefined()
  })
})
