import { atom } from 'jotai'

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
    return true
  }

  const persistedPreference = readPersistedDarkMode()

  if (persistedPreference !== null) {
    return persistedPreference
  }

  // Match useIsDarkMode: Ophis defaults to dark, regardless of the wallet's OS theme.
  return true
}

const initialDarkMode = getInitialDarkModePreference()

export const themeConfigAtom = atom(getCowswapTheme(initialDarkMode))
