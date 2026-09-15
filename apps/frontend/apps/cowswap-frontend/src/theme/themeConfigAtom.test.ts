import { isInjectedWidget } from '@cowprotocol/common-utils'

import { load } from 'redux-localstorage-simple'

jest.mock('@cowprotocol/common-utils', () => ({ isInjectedWidget: jest.fn(() => false) }))

jest.mock('redux-localstorage-simple', () => ({ load: jest.fn() }))
jest.mock('./getCowswapTheme', () => ({ getCowswapTheme: (darkMode: boolean) => ({ darkMode }) }))

describe('initial wallet browser theme', () => {
  beforeEach(() => jest.mocked(isInjectedWidget).mockReturnValue(false))

  it('preserves the embedded dark default', () => {
    jest.mocked(isInjectedWidget).mockReturnValue(true)
    jest.mocked(load).mockReturnValue({})
    jest.isolateModules(() => {
      const { createStore } = jest.requireActual<typeof import('jotai')>('jotai')
      const { themeConfigAtom } = jest.requireActual<typeof import('./themeConfigAtom')>('./themeConfigAtom')
      expect(createStore().get(themeConfigAtom).darkMode).toBe(true)
    })
  })
  it.each([
    [undefined, false],
    [{ userDarkMode: null, matchesDarkMode: false }, false],
    [{ userDarkMode: false, matchesDarkMode: true }, false],
    [{ userDarkMode: true }, true],
  ])('matches the runtime preference for %j', (user, darkMode) => {
    jest.mocked(load).mockReturnValue({ user })
    jest.isolateModules(() => {
      const { createStore } = jest.requireActual<typeof import('jotai')>('jotai')
      const { themeConfigAtom } = jest.requireActual<typeof import('./themeConfigAtom')>('./themeConfigAtom')
      expect(createStore().get(themeConfigAtom).darkMode).toBe(darkMode)
    })
  })

  it('boots in light mode when wallet storage is unavailable', () => {
    jest.mocked(load).mockImplementation(() => {
      throw new Error('Storage denied')
    })
    jest.isolateModules(() => {
      const { createStore } = jest.requireActual<typeof import('jotai')>('jotai')
      const { themeConfigAtom } = jest.requireActual<typeof import('./themeConfigAtom')>('./themeConfigAtom')
      expect(createStore().get(themeConfigAtom).darkMode).toBe(false)
    })
  })
})
