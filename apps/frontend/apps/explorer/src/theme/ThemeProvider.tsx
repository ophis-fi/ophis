import React, { PropsWithChildren, ReactNode } from 'react'

import { baseTheme } from '@cowprotocol/ui'

import { css, ThemeProvider as StyledComponentsThemeProvider } from 'styled-components/macro'

import { getFonts } from './styles'
import { Theme } from './types'

const themeObject = {
  ...baseTheme(Theme.LIGHT),
  mode: Theme.LIGHT,
  primary: '#17191c',
  text: '#17191c',
  background: '#ffffff',
  paper: '#ffffff',
  ...getFonts(),
  colorScrollbar: css`
    --scrollbarWidth: 0.6rem;

    &::-webkit-scrollbar {
      width: var(--scrollbarWidth);
      height: var(--scrollbarWidth);
    }
    &::-webkit-scrollbar-thumb {
      background: #b8bbc2;
      border-radius: 2rem;
    }
    &::-webkit-scrollbar-track {
      background: #f2f2f3;
    }
  `,
}

export function ThemeProvider({ children }: PropsWithChildren): ReactNode {
  return <StyledComponentsThemeProvider theme={themeObject}>{children}</StyledComponentsThemeProvider>
}
