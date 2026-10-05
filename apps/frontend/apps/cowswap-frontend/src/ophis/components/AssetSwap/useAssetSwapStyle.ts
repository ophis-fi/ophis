import { CSSProperties } from 'react'

import { getContrastText } from '@cowprotocol/ui-utils'

import { parseToRgba } from 'color2k'
import { useTheme } from 'styled-components/macro'

export function useAssetSwapStyle(): CSSProperties {
  const theme = useTheme()
  // Ophis exposes complete colors, not RGB triplets. Derive the channels from
  // the same active theme (including embedded palettes), locally on each root.
  return {
    '--ink-rgb': parseToRgba(theme.text).slice(0, 3).join(', '),
    '--fill-on-rgb': parseToRgba(getContrastText(theme.paper, theme.text)).slice(0, 3).join(', '),
  } as CSSProperties
}
