import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ chain: 1, environment: 'ethereum', text: { textContent: '' },
  policy: {} as Record<number, { expiresAt: number }[]> }))
vi.mock('./config', () => ({ get CHAIN_ID() { return state.chain },
  get CHAIN_NAME() { return state.chain === 1 ? 'Ethereum' : 'BNB Chain' },
  get ENVIRONMENT() { return state.environment }, PROTECTED_BROADCASTERS: state.policy }))
vi.mock('./ui', () => ({ element: () => state.text }))

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'))
  state.chain = 1; state.environment = 'ethereum'; state.text.textContent = ''
  for (const chain of Object.keys(state.policy)) delete state.policy[Number(chain)]
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('removes the private-submission claim at the actual approval safety cutoff', async () => {
  state.policy[1] = [{ expiresAt: Date.now() + 15 * 60_000 + 1000 }]
  const { updatePrivateSubmissionHelp } = await import('./network-ui')
  updatePrivateSubmissionHelp()
  expect(state.text.textContent).toContain('Ethereum swaps use private submission')
  await vi.advanceTimersByTimeAsync(1000)
  expect(state.text.textContent).toContain('are not available')
  expect(state.text.textContent).toContain('saved-transaction recovery')
})

it('keeps non-expiring approval available without overflowing the refresh timer', async () => {
  vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
  state.policy[1] = [{ expiresAt: Number.POSITIVE_INFINITY }]
  const { updatePrivateSubmissionHelp } = await import('./network-ui')
  updatePrivateSubmissionHelp()
  await vi.advanceTimersByTimeAsync(2_147_483_647)
  expect(state.text.textContent).toContain('Ethereum swaps use private submission')
  expect(vi.getTimerCount()).toBe(1)
})

it('does not describe mainnet private submission in a fork even with an approval', async () => {
  state.environment = 'fork'
  state.policy[1] = [{ expiresAt: Date.now() + 3_600_000 }]
  const { updatePrivateSubmissionHelp } = await import('./network-ui')
  updatePrivateSubmissionHelp()
  expect(state.text.textContent).toBe('Local fork: mainnet broadcaster submission is disabled.')
  expect(vi.getTimerCount()).toBe(0)
})

it('uses the selected chain approval and keeps availability until the last approval reaches its cutoff', async () => {
  state.chain = 56
  state.policy[1] = [{ expiresAt: Date.now() + 3_600_000 }]
  const { updatePrivateSubmissionHelp } = await import('./network-ui')
  updatePrivateSubmissionHelp()
  expect(state.text.textContent).toContain('are not available')
  state.policy[56] = [{ expiresAt: Date.now() + 900_500 }, { expiresAt: Date.now() + 901_000 }]
  updatePrivateSubmissionHelp()
  await vi.advanceTimersByTimeAsync(500)
  expect(state.text.textContent).toContain('BNB Chain swaps use private submission')
  await vi.advanceTimersByTimeAsync(500)
  expect(state.text.textContent).toContain('are not available')
})
