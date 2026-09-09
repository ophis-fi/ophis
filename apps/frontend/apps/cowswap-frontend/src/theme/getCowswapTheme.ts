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

// Steep editorial anchors for the app and default embedded widget (approved reference:
// DESIGN.md + expansion/app.html + styles.css). Mirrors
// `--ophis-steep-*` in ophis/styles.css.
const STEEP = {
  ink: '#17191c',
  paper: '#ffffff',
  mist: '#f2f2f3',
  fog: '#fafafb',
  slate: '#777b86',
  smoke: '#a3a6af',
  peach: '#fbe1d1',
  brown: '#5d2a1a',
  hair: '#e8e8ea',
  line: '#d9d9dc',
  darkBg: '#17191c',
  darkCard: '#1e2126',
  darkCardHover: '#262b31',
  darkText: '#f4f4f5',
  darkHair: '#2e333a',
}

/**
 * Default app and widget palette — approved Steep semantic tokens.
 * Mirrors `mobileSwapTheme.constants.ts` for light (the validated Steep
 * reference) without setting `isOphisMobileSwap`, which must stay
 * swap-only. Dark resolves to a neutral-ink variant (no cosmic purple,
 * no saffron) so a persisted dark preference keeps a coherent shell.
 */
function steepOverrides(darkMode: boolean): Record<string, string> {
  if (darkMode) {
    return {
      // Filled pill CTA on dark: light pill, ink label.
      primary: STEEP.mist,
      buttonTextCustom: STEEP.ink,
      // State colors — functional ramps (unchanged semantics).
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
      // Info banners resolve to the peach accent on dark.
      info: STEEP.peach,
      infoDark: STEEP.brown,
      // ── Neutral-ink dark surfaces ───────────────────────────────
      paper: STEEP.darkCard,
      background: STEEP.darkBg,
      paperDark: STEEP.darkCard,
      darkerDark: STEEP.darkBg,
      paperCustom: STEEP.darkCard,
      paperDarkerCustom: STEEP.darkCardHover,
      paperDarkestCustom: STEEP.darkHair,
      text: STEEP.darkText,
      text1: STEEP.darkText,
      text4: STEEP.smoke,
      textDark: STEEP.darkText,
      disabledText: STEEP.slate,
      disabledTextDark: STEEP.slate,
      grey1: STEEP.darkCardHover,
      grey1Dark: STEEP.darkCardHover,
      bg2: STEEP.darkCard,
      bg3: STEEP.darkCard,
      bg5: STEEP.darkCardHover,
      bg8: STEEP.darkBg,
      border: STEEP.darkHair,
      border2: STEEP.darkHair,
      blueDark2: STEEP.darkCard,
      blueDark3: STEEP.darkCard,
      blueDark4: STEEP.darkBg,
      blueLight1: STEEP.darkText,
      boxShadow1: '0 1px 2px rgba(0, 0, 0, 0.4)',
      boxShadow2: '0 16px 40px rgba(0, 0, 0, 0.35)',
    }
  }
  return {
    // Filled pill CTA: ink pill, paper label.
    primary: STEEP.ink,
    buttonTextCustom: STEEP.paper,
    // State colors — functional ramps (unchanged semantics).
    success: ophisColors.green[50],
    successDark: ophisColors.green[40],
    successLight: ophisColors.green[50],
    warning: '#a13b1f',
    warningLight: ophisColors.yellow[40],
    alert: '#b66a16',
    alertLight: ophisColors.yellow[40],
    danger: ophisColors.red[50],
    error: ophisColors.red[50],
    // Info banners resolve to the sienna accent on light.
    info: STEEP.brown,
    infoDark: STEEP.brown,
    // ── Steep light surfaces ──────────────────────────────────────
    paper: STEEP.paper,
    background: STEEP.paper,
    paperCustom: STEEP.paper,
    paperDarkerCustom: STEEP.mist,
    paperDarkestCustom: STEEP.hair,
    text: STEEP.ink,
    text1: STEEP.ink,
    text4: STEEP.slate,
    bg2: STEEP.mist,
    bg3: STEEP.mist,
    bg5: STEEP.fog,
    bg8: STEEP.paper,
    grey1: STEEP.mist,
    border: STEEP.hair,
    border2: STEEP.line,
    boxShadow1: '0 1px 2px rgba(23,25,28,.04)',
    boxShadow2: '0 16px 40px rgba(23,25,28,.06)',
  }
}

export function getCowswapTheme(darkmode: boolean): CoWSwapTheme {
  const base = baseTheme(darkmode ? 'dark' : 'light')
  // Hosts can still supply their own palette through mapWidgetTheme.
  const overrides = steepOverrides(darkmode)
  return {
    ...base,
    ...overrides,
    ...widgetMode,
  }
}
