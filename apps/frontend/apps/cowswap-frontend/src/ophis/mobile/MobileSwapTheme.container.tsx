import { ReactNode } from 'react'

import { ThemeProvider, useTheme } from 'styled-components/macro'
import { ThemedGlobalStyle } from 'theme/ThemedGlobalStyle'

import { MobileSwapGlobalStyle } from './MobileSwapGlobalStyle.styled'
import { mobileSwapTheme } from './mobileSwapTheme.constants'

import { useIsMobileSwap } from '../hooks/useIsMobileSwap'

export function MobileSwapTheme({ children }: { children: ReactNode }): ReactNode {
  const inheritedTheme = useTheme()
  const isMobileSwap = useIsMobileSwap()
  return (
    <ThemeProvider theme={isMobileSwap ? mobileSwapTheme : inheritedTheme}>
      {isMobileSwap && (
        <>
          <ThemedGlobalStyle />
          <MobileSwapGlobalStyle />
        </>
      )}
      {children}
    </ThemeProvider>
  )
}
