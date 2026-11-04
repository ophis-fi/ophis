import { beforeEach, expect, it, vi } from 'vitest'
import { CONFIG, VERSION } from './config'

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

it('publishes balances without waiting for or contacting a PPOI provider', async () => {
  sdk.refresh.mockRejectedValue(new Error('PPOI unavailable'))
  await refreshReceivedBalances(session)
  expect(sdk.refresh).not.toHaveBeenCalled()
  expect(sdk.publish).toHaveBeenCalledExactlyOnceWith(VERSION, sdk.wallet, CONFIG.chain)
})

it('propagates a refresh rejection without publishing stale buckets and permits a later retry', async () => {
  sdk.publish.mockRejectedValueOnce(new Error('Balance update failed'))
  await expect(refreshReceivedBalances(session)).rejects.toThrow('Balance update failed')
  await refreshReceivedBalances(session)
  expect(sdk.refresh).not.toHaveBeenCalled()
  expect(sdk.publish).toHaveBeenCalledTimes(2)
})

it('waits for the history scan before publishing refreshed balances', async () => {
  let complete: (() => void) | undefined
  sdk.scan.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
  const pending = syncWallet(session)
  expect(sdk.scan).toHaveBeenCalledExactlyOnceWith(CONFIG.chain, [session.info.id])
  expect(sdk.publish).not.toHaveBeenCalled()
  complete?.()
  await pending
  expect(sdk.refresh).not.toHaveBeenCalled()
  expect(sdk.publish).toHaveBeenCalledTimes(1)
})
