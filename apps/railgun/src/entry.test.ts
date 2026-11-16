import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ chain: 1, environment: 'ethereum', start: vi.fn() }))
vi.mock('./config', () => ({ get CHAIN_ID() { return state.chain }, get ENVIRONMENT() { return state.environment },
  get CHAIN_NAME() { return state.chain === 137 ? 'Polygon' : state.chain === 8453 ? 'Base' : 'Ethereum' } }))

const replaceChildren = vi.fn()
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); state.environment = 'ethereum'
  vi.doMock('./main', () => { state.start(); return {} })
  vi.stubGlobal('location', { href: 'https://swap.ophis.fi/private/?chainId=8453' })
  vi.stubGlobal('document', { querySelector: () => ({ replaceChildren }),
    createElement: () => ({ textContent: '', href: '', className: '', append: vi.fn(), setAttribute: vi.fn() }) })
})
afterEach(() => vi.unstubAllGlobals())

it.each([137, 8453])('does not load wallet code or silently switch a disabled production chain %s', async chain => {
  state.chain = chain
  await import('./entry'); await vi.dynamicImportSettled()
  expect(state.start).not.toHaveBeenCalled()
  const [title, help, nav] = replaceChildren.mock.calls[0]
  expect(title.textContent).toContain('private swaps are unavailable')
  expect(help.textContent).toContain('data has not been changed')
  expect(nav.setAttribute).toHaveBeenCalledWith('aria-label', 'Available private networks')
  expect(nav.append.mock.calls.map(([link]: [{ href: string }]) => new URL(link.href).searchParams.get('chainId'))).toEqual(['1', '42161', '56'])
  expect(location.href).toBe('https://swap.ophis.fi/private/?chainId=8453')
})

it.each([1, 56, 42161])('starts the existing wallet for enabled production chain %s', async chain => {
  state.chain = chain
  await import('./entry'); await vi.dynamicImportSettled()
  expect(state.start).toHaveBeenCalledOnce()
  expect(replaceChildren).not.toHaveBeenCalled()
})

it.each([137, 8453])('retains isolated fork development for chain %s', async chain => {
  state.chain = chain; state.environment = 'fork'
  await import('./entry'); await vi.dynamicImportSettled()
  expect(state.start).toHaveBeenCalledOnce()
})
