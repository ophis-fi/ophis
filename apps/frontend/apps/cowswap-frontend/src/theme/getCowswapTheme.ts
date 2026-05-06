// These values are static and don't change during runtime
import { isIframe, isInjectedWidget } from '@cowprotocol/common-utils'
import { baseTheme } from '@cowprotocol/ui'

import { CoWSwapTheme } from 'styled-components'

import { colors as gregColors } from '../greg/tokens'

const isWidget = isInjectedWidget()
const widgetMode = {
  isWidget,
  isIframe: isIframe(),
}

/**
 * Greg theme overrides — applied on top of CoW's baseTheme().
 *
 * Strategy: keep CoW's full theme structure (neutrals, blue aliases, etc.) and
 * override only the keys that drive Greg's brand identity. The CoW codebase
 * reads colors via styled-components `theme.X` keys AND via CSS custom
 * properties emitted by ThemeColorVars from those same keys, so overriding the
 * theme keys cascades through both layers.
 *
 * See `src/greg/tokens.ts` for the source-of-truth values.
 */
function gregOverrides(darkMode: boolean): Record<string, string> {
  if (darkMode) {
    return {
      // Brand
      primary: gregColors.brand[50],
      buttonTextCustom: gregColors.neutral[100],
      // State colors
      success: gregColors.green[40],
      successDark: gregColors.green[40],
      successLight: gregColors.green[50],
      warning: gregColors.yellow[30],
      warningDark: gregColors.yellow[30],
      alert: gregColors.yellow[30],
      alertDark: gregColors.yellow[30],
      danger: gregColors.red[40],
      dangerDark: gregColors.red[40],
      error: gregColors.red[40],
      errorDark: gregColors.red[40],
      info: gregColors.blue[40],
      infoDark: gregColors.blue[40],
    }
  }
  return {
    // Brand
    primary: gregColors.brand[60],
    buttonTextCustom: gregColors.white,
    // State colors
    success: gregColors.green[50],
    successDark: gregColors.green[40],
    successLight: gregColors.green[50],
    warning: gregColors.yellow[40],
    warningLight: gregColors.yellow[40],
    alert: gregColors.yellow[40],
    alertLight: gregColors.yellow[40],
    danger: gregColors.red[50],
    error: gregColors.red[50],
    info: gregColors.blue[50],
    infoDark: gregColors.blue[60],
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
