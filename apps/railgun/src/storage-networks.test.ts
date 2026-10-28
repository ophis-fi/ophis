import { afterEach, expect, it, vi } from 'vitest'
import { id } from 'ethers'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ records: new Map<string, string>() }))
vi.mock('level-js', () => ({ default: () => ({}) }))
vi.mock('levelup', () => ({ default: () => ({}) }))
vi.mock('@railgun-community/wallet', () => ({
  ArtifactStore: class {},
  getEngine: () => ({ db: {
    putEncrypted: async (path: unknown[], _key: string, value: Buffer) => { state.records.set(String(path.at(-1)), value.toString('hex')) },
    getEncrypted: async (path: unknown[]) => state.records.get(String(path.at(-1))),
  } }),
}))
afterEach(() => vi.unstubAllGlobals())

it('keeps pending state separate on four chains and preserves the Ethereum key', async () => {
  state.records.clear()
  const session = { info: { id: 'unfunded-test-wallet' }, key: 'test-key' } as WalletSession
  for (const chain of [1, 42161, 137, 56]) {
    vi.resetModules()
    vi.stubGlobal('location', new URL(`http://localhost/?chainId=${chain}`))
    const { writePrivateState } = await import('./storage')
    await writePrivateState(session, 'pendingSwap', { chain })
  }
  expect(state.records.size).toBe(4)
  expect(state.records.has(id('pendingSwap'))).toBe(true)
  for (const chain of [56, 137, 42161, 1]) {
    vi.resetModules()
    vi.stubGlobal('location', new URL(`http://localhost/?chainId=${chain}`))
    const { readPrivateState } = await import('./storage')
    expect(await readPrivateState(session, 'pendingSwap')).toEqual({ chain })
  }
})
