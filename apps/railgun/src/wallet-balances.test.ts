import { beforeEach, expect, it, vi } from 'vitest'
import { CONFIG, NETWORK, VERSION } from './config'

const sdk = vi.hoisted(() => ({ refresh: vi.fn(), publish: vi.fn(), scan: vi.fn(), wallet: {} }))
vi.mock('@railgun-community/wallet', () => ({
  refreshReceivePOIsForWallet: sdk.refresh,
  onBalancesUpdate: sdk.publish,
  refreshBalances: sdk.scan,
  fullWalletForID: () => sdk.wallet,
}))
vi.mock('./storage', () => ({}))

import { refreshReceivedBalances, syncWallet, type WalletSession } from './wallet'
const session = { info: { id: 'test-wallet' } } as WalletSession

beforeEach(() => {
  for (const fn of [sdk.refresh, sdk.publish, sdk.scan]) fn.mockReset().mockResolvedValue(undefined)
})

it('coalesces overlapping receive refreshes and publishes buckets only after POI metadata updates', async () => {
  let complete: (() => void) | undefined
  sdk.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
  const first = refreshReceivedBalances(session)
  const second = refreshReceivedBalances(session)
  expect(first).toBe(second)
  expect(sdk.refresh).toHaveBeenCalledExactlyOnceWith(VERSION, NETWORK, session.info.id)
  expect(sdk.publish).not.toHaveBeenCalled()
  complete?.()
  await first
  expect(sdk.publish).toHaveBeenCalledExactlyOnceWith(VERSION, sdk.wallet, CONFIG.chain)
})

it('propagates a refresh rejection without publishing stale buckets and permits a later retry', async () => {
  sdk.refresh.mockRejectedValueOnce(new Error('POI unavailable'))
  await expect(refreshReceivedBalances(session)).rejects.toThrow('POI unavailable')
  expect(sdk.publish).not.toHaveBeenCalled()
  await refreshReceivedBalances(session)
  expect(sdk.refresh).toHaveBeenCalledTimes(2)
  expect(sdk.publish).toHaveBeenCalledTimes(1)
})

it('refreshes received POIs after the existing history scan when balances are refreshed', async () => {
  let complete: (() => void) | undefined
  sdk.scan.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
  const pending = syncWallet(session)
  expect(sdk.scan).toHaveBeenCalledExactlyOnceWith(CONFIG.chain, [session.info.id])
  expect(sdk.refresh).not.toHaveBeenCalled()
  complete?.()
  await pending
  expect(sdk.refresh).toHaveBeenCalledTimes(1)
  expect(sdk.publish).toHaveBeenCalledTimes(1)
})
