import type { CowSwapWidgetPalette } from '@cowprotocol/widget-lib'

import { getCowswapTheme } from './getCowswapTheme'
import { mapWidgetTheme } from './mapWidgetTheme'

import type { DefaultTheme } from 'styled-components/macro'

jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: () => true, isIframe: () => true }))

describe('mapWidgetTheme', () => {
  it.each([false, true])('uses Steep widget defaults while retaining host overrides (dark: %s)', (dark) => {
    const defaults = getCowswapTheme(dark)
    expect(defaults).toMatchObject({
      isWidget: true,
      isIframe: true,
      background: dark ? '#17191c' : '#ffffff',
      primary: dark ? '#f2f2f3' : '#17191c',
    })
    expect(mapWidgetTheme(undefined, defaults)).toBe(defaults)
    expect(mapWidgetTheme({ paper: '#101010', primary: '#abcdef' }, defaults)).toMatchObject({
      paper: '#101010',
      primary: '#abcdef',
      buttonTextCustom: '#101010',
    })
  })

  it('maps custom widget shadow to the main widget container shadow', () => {
    const defaultTheme = {
      boxShadow1: '0 12px 12px rgba(5, 43, 101, 0.06)',
      paper: '#ffffff',
    } as DefaultTheme

    const widgetTheme: Partial<CowSwapWidgetPalette> = {
      paper: '#101010',
      boxShadow: 'none',
    }

    const result = mapWidgetTheme(widgetTheme, defaultTheme)

    expect(result.paper).toBe('#101010')
    expect(result.buttonTextCustom).toBe('#101010')
    expect(result.boxShadow1).toBe('none')
  })
})
