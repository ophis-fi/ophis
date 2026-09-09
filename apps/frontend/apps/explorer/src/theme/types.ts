import { CowProtocolTheme } from '@cowprotocol/ui'

import { Fonts } from './styles'

export enum Theme {
  DARK = 'dark',
  LIGHT = 'light',
}

type ThemeMode = Theme

declare module 'styled-components' {
  export interface ExplorerTheme extends Fonts {
    mode: ThemeMode
  }

  export interface DefaultTheme extends CowProtocolTheme, ExplorerTheme {}
}
