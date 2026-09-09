import { baseTheme } from '@cowprotocol/ui'

import { CoWSwapTheme } from 'styled-components'

// Validated Refero / Steep reference. Georgia and Inter are its documented font fallbacks.
export const mobileSwapTheme: CoWSwapTheme = {
  ...baseTheme('light'),
  isWidget: false,
  isIframe: false,
  isOphisMobileSwap: true,
  primary: '#17191c',
  buttonTextCustom: '#ffffff',
  background: '#ffffff',
  paper: '#ffffff',
  paperCustom: '#ffffff',
  paperDarkerCustom: '#f2f2f3',
  paperDarkestCustom: '#e8e8ea',
  text: '#17191c',
  text1: '#17191c',
  text4: '#5b606b',
  bg2: '#f2f2f3',
  bg3: '#f2f2f3',
  bg5: '#fafafb',
  bg8: '#ffffff',
  grey1: '#f2f2f3',
  border: '#e8e8ea',
  border2: '#d9d9dc',
  info: '#5d2a1a',
  boxShadow1: '0 1px 2px rgba(23,25,28,.04)',
  boxShadow2: '0 16px 40px rgba(23,25,28,.06)',
}
