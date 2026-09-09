import { Theme } from 'theme/types'

const THEME_MANAGER: [Theme, (newTheme: Theme) => void] = [Theme.LIGHT, () => {}]

export function useThemeMode(): Theme {
  return Theme.LIGHT
}

export function useThemeManager(): [Theme, (newTheme: Theme) => void] {
  return THEME_MANAGER
}
