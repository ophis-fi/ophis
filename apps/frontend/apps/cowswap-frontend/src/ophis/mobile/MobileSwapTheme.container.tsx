import { ReactNode, useEffect } from 'react'

import { ThemeProvider, useTheme } from 'styled-components/macro'
import { ThemedGlobalStyle } from 'theme/ThemedGlobalStyle'

import { MobileSwapGlobalStyle } from './MobileSwapGlobalStyle.styled'
import { mobileSwapTheme } from './mobileSwapTheme.constants'

import { useIsOphisSwap } from '../hooks/useIsOphisSwap'

export function MobileSwapTheme({ children }: { children: ReactNode }): ReactNode {
  const inheritedTheme = useTheme()
  const isSwap = useIsOphisSwap()
  const theme = isSwap ? mobileSwapTheme : inheritedTheme

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.background)
  }, [theme.background])

  return (
    <ThemeProvider theme={theme}>
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
