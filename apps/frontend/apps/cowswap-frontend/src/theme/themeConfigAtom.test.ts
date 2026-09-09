import { load } from 'redux-localstorage-simple'

jest.mock('redux-localstorage-simple', () => ({ load: jest.fn() }))
jest.mock('./getCowswapTheme', () => ({ getCowswapTheme: (darkMode: boolean) => ({ darkMode }) }))

describe('initial wallet browser theme', () => {
  it.each([
    [undefined, true],
    [{ userDarkMode: null, matchesDarkMode: false }, true],
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

  it('still boots in dark mode when wallet storage is unavailable', () => {
    jest.mocked(load).mockImplementation(() => {
      throw new Error('Storage denied')
    })
    jest.isolateModules(() => {
      const { createStore } = jest.requireActual<typeof import('jotai')>('jotai')
      const { themeConfigAtom } = jest.requireActual<typeof import('./themeConfigAtom')>('./themeConfigAtom')
      expect(createStore().get(themeConfigAtom).darkMode).toBe(true)
    })
  })
})
