// These values are static and don't change during runtime
import { isIframe, isInjectedWidget } from '@cowprotocol/common-utils'
import { baseTheme } from '@cowprotocol/ui'

import { CoWSwapTheme } from 'styled-components'

import { colors as ophisColors } from '../ophis/tokens'

const isWidget = isInjectedWidget()
const widgetMode = {
  isWidget,
  isIframe: isIframe(),
}

/**
 * Ophis theme overrides — applied on top of CoW's baseTheme().
 *
 * Strategy: keep CoW's full theme structure (neutrals, blue aliases, etc.) and
 * override only the keys that drive Ophis's brand identity. The CoW codebase
 * reads colors via styled-components `theme.X` keys AND via CSS custom
 * properties emitted by ThemeColorVars from those same keys, so overriding the
 * theme keys cascades through both layers.
 *
 * See `src/ophis/tokens.ts` for the source-of-truth values.
 */
// Cosmic-palette anchors for Ophis dark surfaces (sourced from the new
// design mockup at /Users/scep/Desktop/website mockups/new-layout-website.svg).
const COSMIC = {
  bgDeep: '#02000d', // page background
  bgPaper: '#13072B', // card surface — purple-tinted near-black
  bgPaperHover: '#1A0F36',
  bgInput: '#0B0421',
  bgInputHover: '#100A2C',
  textPrimary: '#F5EFE6', // cream
  textMuted: '#A8A2B8', // lavender-grey
  textDisabled: '#5A5470',
  indigo: '#7A6EE0', // info accent
  indigoStrong: '#4F1DCA',
}

function gregOverrides(darkMode: boolean): Record<string, string> {
  if (darkMode) {
    return {
      // Brand
      primary: ophisColors.brand[50],
      buttonTextCustom: ophisColors.neutral[100],
      // State colors
      success: ophisColors.green[40],
      successDark: ophisColors.green[40],
      successLight: ophisColors.green[50],
      warning: ophisColors.yellow[30],
      warningDark: ophisColors.yellow[30],
      alert: ophisColors.yellow[30],
      alertDark: ophisColors.yellow[30],
      danger: ophisColors.red[40],
      dangerDark: ophisColors.red[40],
      error: ophisColors.red[40],
      errorDark: ophisColors.red[40],
      // Info — cowswap uses blue here (drives DCA banner + hint
      // backgrounds). Override to cosmic indigo so the swap-form
      // banners stop looking like CoW.
      info: COSMIC.indigo,
      infoDark: COSMIC.indigoStrong,
      // ── Ophis cosmic surfaces ───────────────────────────────────
      // These keys feed `--cow-color-paper`, `--cow-color-background`,
      // `--cow-color-text`, etc. via ThemeColorVars, so overriding
      // them cascades through every cowswap component (cards, input
      // rows, modals).
      paper: COSMIC.bgPaper,
      background: COSMIC.bgDeep,
      paperDark: COSMIC.bgPaper,
      darkerDark: COSMIC.bgDeep,
      text: COSMIC.textPrimary,
      text1: COSMIC.textPrimary,
      text4: COSMIC.textMuted,
      textDark: COSMIC.textPrimary,
      disabledText: COSMIC.textDisabled,
      disabledTextDark: COSMIC.textDisabled,
      grey1: COSMIC.bgPaperHover,
      grey1Dark: COSMIC.bgPaperHover,
      bg2: COSMIC.bgInput,
      bg3: COSMIC.bgInput,
      bg5: COSMIC.bgInputHover,
      bg8: COSMIC.bgDeep,
      blueDark2: COSMIC.bgInput,
      blueDark3: COSMIC.bgPaper,
      blueDark4: COSMIC.bgDeep,
      blueLight1: COSMIC.textPrimary,
    }
  }
  return {
    // Brand
    primary: ophisColors.brand[60],
    buttonTextCustom: ophisColors.white,
    // State colors
    success: ophisColors.green[50],
    successDark: ophisColors.green[40],
    successLight: ophisColors.green[50],
    warning: ophisColors.yellow[40],
    warningLight: ophisColors.yellow[40],
    alert: ophisColors.yellow[40],
    alertLight: ophisColors.yellow[40],
    danger: ophisColors.red[50],
    error: ophisColors.red[50],
    info: ophisColors.blue[50],
    infoDark: ophisColors.blue[60],
  }
}

export function getCowswapTheme(darkmode: boolean): CoWSwapTheme {
  const base = baseTheme(darkmode ? 'dark' : 'light')
  return {
    ...base,
    ...gregOverrides(darkmode),
    ...widgetMode,
  }
}
