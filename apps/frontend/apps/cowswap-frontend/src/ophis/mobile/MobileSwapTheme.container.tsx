import { ReactNode } from 'react'

import { ThemeProvider, useTheme } from 'styled-components/macro'
import { ThemedGlobalStyle } from 'theme/ThemedGlobalStyle'

import { MobileSwapGlobalStyle } from './MobileSwapGlobalStyle.styled'
import { mobileSwapTheme } from './mobileSwapTheme.constants'

import { useIsOphisSwap } from '../hooks/useIsOphisSwap'

export function MobileSwapTheme({ children }: { children: ReactNode }): ReactNode {
  const inheritedTheme = useTheme()
  const isSwap = useIsOphisSwap()
  return (
    <ThemeProvider theme={isSwap ? mobileSwapTheme : inheritedTheme}>
      {isSwap && (
        <>
          <ThemedGlobalStyle />
          <MobileSwapGlobalStyle />
        </>
      )}
      {children}
    </ThemeProvider>
  )
}
