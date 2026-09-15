import { useAtomValue } from 'jotai'

import { renderHook } from '@testing-library/react'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { useVolumeFeeTooltip } from './useVolumeFeeTooltip'

import { LinguiWrapper } from '../../../../LinguiJestProvider'
import { hostFeeKindAtom, isBoostedTradeAtom, widgetPartnerFeeAtom } from '../state/volumeFeeAtom'

jest.mock('ophis/partnerFeeDefault', () => ({ OPHIS_FLAT_VOLUME_FEE_ENABLED: true }))

jest.mock('jotai', () => ({ useAtomValue: jest.fn() }))
jest.mock('modules/injectedWidget', () => ({ useInjectedWidgetParams: jest.fn() }))
jest.mock('../state/safeAppFeeAtom', () => ({ safeAppFeeAtom: Symbol('safeAppFee') }))
jest.mock('../state/volumeFeeAtom', () => ({
  hostFeeKindAtom: Symbol('hostFeeKind'),
  widgetPartnerFeeAtom: Symbol('widgetPartnerFee'),
  isBoostedTradeAtom: Symbol('isBoostedTrade'),
}))

describe.each([false, true])('boosted trade: %s', (isBoosted) => {
  it.each([undefined, 0, 50])('describes only the fees charged when the resolved host fee is %s', (volumeBps) => {
    jest.mocked(useInjectedWidgetParams).mockReturnValue({
      content: { feeLabel: 'Acme fee', feeTooltipMarkdown: 'Acme charges this fee.' },
    })
    jest.mocked(useAtomValue).mockImplementation((atom) => {
      if (atom === isBoostedTradeAtom) return isBoosted
      if (atom === hostFeeKindAtom) return 'third-party'
      if (atom === widgetPartnerFeeAtom) return volumeBps === undefined ? undefined : { volumeBps }
      return undefined
    })

    const { result } = renderHook(() => useVolumeFeeTooltip(), { wrapper: LinguiWrapper })

    if (volumeBps) {
      expect(result.current.label).toBe('Fees')
      expect(result.current.content).toContain('Acme fee charged by this app and the Ophis fee')
    } else {
      expect(result.current.label).toBe('Ophis fee')
      expect(result.current.content).toBe('The Ophis fee is applied only if the trade is executed.')
    }
  })
})
