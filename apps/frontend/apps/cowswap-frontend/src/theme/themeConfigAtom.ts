import { atom } from 'jotai'

import { isInjectedWidget } from '@cowprotocol/common-utils'

import { load } from 'redux-localstorage-simple'

import { getCowswapTheme } from './getCowswapTheme'

function readPersistedDarkMode(): boolean | null {
  try {
    const persistedState = load({ states: ['user'], disableWarnings: true }) as {
      user?: {
        userDarkMode?: boolean | null
      }
    }

    const { userDarkMode } = persistedState?.user ?? {}

    if (typeof userDarkMode === 'boolean') {
      return userDarkMode
    }
  } catch {
    // ignore localStorage access issues
  }

  return null
}

function getInitialDarkModePreference(): boolean {
  if (typeof window === 'undefined') {
    return isInjectedWidget()
  }

  const persistedPreference = readPersistedDarkMode()

  if (persistedPreference !== null) {
    return persistedPreference
  }

  // Match useIsDarkMode: standalone starts light; keep the embedded default.
  return isInjectedWidget()
}

const initialDarkMode = getInitialDarkModePreference()

export const themeConfigAtom = atom(getCowswapTheme(initialDarkMode))
