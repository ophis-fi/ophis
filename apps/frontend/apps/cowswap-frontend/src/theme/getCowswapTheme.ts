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

// Cosmic-palette anchors for the EMBEDDED WIDGET dark surfaces (sourced from
// the new design mockup at /Users/scep/Desktop/website mockups/new-layout-website.svg).
// Widget-only: the standalone app uses STEEP below.
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

const SUNSET = {
  primary: ophisColors.brand[60],
  primaryLight: ophisColors.brand[80],
}

// Steep editorial anchors for the STANDALONE app (approved reference:
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

function gregOverrides(darkMode: boolean): Record<string, string> {
  if (darkMode) {
    return {
      // Brand — saffron sunset, matches the rest of the Ophis brand
      // (header wordmark, hero accent, ds/ primitives, business page).
      // Previously this was `ophisColors.brand[50]` (#FF7A60 coral) which
      // made the swap form look noticeably different from every other
      // Ophis surface. Now drives `--cow-color-primary` + derived
      // PRIMARY_LIGHTER / DARKER / PAPER / OPACITY_* variables so the
      // swap form, token selector, chain selector, wallet modal, and
      // every other cowswap component re-color to match.
      primary: SUNSET.primary,
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
    // Brand — saffron sunset (slightly deeper variant for better
    // light-mode contrast). Same rationale as the dark-mode override:
    // matches every Ophis-native surface that uses `--sunset` (#f2a63e).
    primary: SUNSET.primaryLight,
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

/**
 * Standalone-app overrides — approved Steep semantic tokens.
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
  // Embedded widget keeps the pre-Steep behavior; the standalone app
  // gets the approved Steep semantic tokens. Deliberately never sets
  // `isOphisMobileSwap` here — that flag is swap-only.
  const overrides = isWidget ? gregOverrides(darkmode) : steepOverrides(darkmode)
  return {
    ...base,
    ...overrides,
    ...widgetMode,
  }
}
