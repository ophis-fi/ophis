import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { CONFIG, VERSION } from './config'
import { MerkletreeScanStatus, type MerkletreeHistoryScanEventData } from '@railgun-community/engine'

const sdk = vi.hoisted(() => ({ refresh: vi.fn(), publish: vi.fn(), scan: vi.fn(), wallet: {},
  callback: undefined as ((event: MerkletreeHistoryScanEventData) => void) | undefined,
  accounts: vi.fn().mockResolvedValue(0),
}))
vi.mock('@railgun-community/wallet', () => ({
  refreshReceivePOIsForWallet: sdk.refresh,
  onBalancesUpdate: sdk.publish,
  refreshBalances: sdk.scan,
  fullWalletForID: () => sdk.wallet,
  startRailgunEngine: vi.fn(), loadProvider: vi.fn(), stopRailgunEngine: vi.fn().mockResolvedValue(undefined),
  setOnBalanceUpdateCallback: vi.fn(), getProver: () => ({ setSnarkJSGroth16: vi.fn() }),
  getEngine: () => ({ on: (_event: string, callback: typeof sdk.callback) => { sdk.callback = callback } }),
}))
vi.mock('./storage', () => ({ walletDB: {}, artifacts: {} }))
vi.mock('../poi-policy', () => ({ disablePPOI: vi.fn() }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  JsonRpcProvider: class {
    getNetwork = async () => ({ chainId: 1n })
    send = async () => ({ forkedNetwork: { chainId: 1 } })
    destroy = vi.fn()
  },
}))

import { refreshReceivedBalances, requireWalletSync, startWalletEngine, syncWallet, type WalletSession } from './wallet'
const session = { info: { id: 'test-wallet' }, accounts: { scanHistoryForEphemeralIndex: sdk.accounts } } as unknown as WalletSession

function complete(status = MerkletreeScanStatus.Complete): void {
  sdk.callback?.({ scanStatus: status, chain: CONFIG.chain, txidVersion: VERSION })
}

beforeAll(async () => {
  vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
  vi.stubGlobal('location', { origin: 'http://localhost' })
  sdk.scan.mockImplementation(async () => { complete() })
  await startWalletEngine(() => {}, () => {})
  await new Promise<void>((resolve) => queueMicrotask(resolve))
})

beforeEach(() => {
  for (const fn of [sdk.refresh, sdk.publish, sdk.scan]) fn.mockReset().mockResolvedValue(undefined)
  sdk.scan.mockImplementation(async () => { complete() })
  sdk.accounts.mockClear()
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
  await vi.waitFor(() => expect(sdk.scan).toHaveBeenCalled())
  expect(sdk.scan).toHaveBeenCalledExactlyOnceWith(CONFIG.chain, [session.info.id])
  expect(sdk.publish).not.toHaveBeenCalled()
  complete?.()
  sdk.callback?.({ scanStatus: MerkletreeScanStatus.Complete, chain: CONFIG.chain, txidVersion: VERSION })
  await pending
  expect(sdk.refresh).not.toHaveBeenCalled()
  expect(sdk.publish).toHaveBeenCalledTimes(1)
  expect(sdk.accounts).toHaveBeenCalledExactlyOnceWith(CONFIG.chain)
  expect(() => requireWalletSync()).not.toThrow()
})

it('keeps spending blocked until the SDK completes verification and balance publication, deduplicating refreshes', async () => {
  sdk.scan.mockImplementationOnce(async () => {})
  const pending = syncWallet(session)
  expect(syncWallet(session)).toBe(pending)
  await vi.waitFor(() => expect(sdk.scan).toHaveBeenCalledOnce())
  expect(() => requireWalletSync()).toThrow(/not synchronized/)
  expect(sdk.publish).not.toHaveBeenCalled()
  complete()
  await pending
  expect(() => requireWalletSync()).not.toThrow()
})

it('fails closed on an incomplete scan and allows a verified retry without PPOI', async () => {
  sdk.scan.mockImplementationOnce(async () => { complete(MerkletreeScanStatus.Incomplete) })
  await expect(syncWallet(session)).rejects.toThrow(/verification is incomplete/)
  expect(() => requireWalletSync()).toThrow(/not synchronized/)
  expect(sdk.publish).not.toHaveBeenCalled()
  await syncWallet(session)
  expect(() => requireWalletSync()).not.toThrow()
  expect(sdk.refresh).not.toHaveBeenCalled()
})

it('verifies public history during setup and waits for it before a wallet scan', async () => {
  const report = vi.fn()
  sdk.scan.mockImplementationOnce(async () => {})
  await startWalletEngine(() => {}, report)
  expect(sdk.scan).toHaveBeenCalledExactlyOnceWith(CONFIG.chain, [])
  const pending = syncWallet(session)
  expect(() => requireWalletSync()).toThrow()
  expect(sdk.scan).toHaveBeenCalledOnce()
  complete()
  await pending
  expect(sdk.scan.mock.calls).toEqual([[CONFIG.chain, []], [CONFIG.chain, ['test-wallet']]])
  expect(report.mock.calls.filter(([, ready]) => ready)).toEqual([['Complete · private balances are ready.', true]])
})

it('does not accept a different chain or proof version as completion of the wallet scan', async () => {
  sdk.scan.mockImplementationOnce(async () => {})
  const pending = syncWallet(session)
  await vi.waitFor(() => expect(sdk.scan).toHaveBeenCalledOnce())
  sdk.callback?.({ scanStatus: MerkletreeScanStatus.Complete, chain: { ...CONFIG.chain, id: 56 }, txidVersion: VERSION })
  expect(() => requireWalletSync()).toThrow()
  sdk.callback?.({ scanStatus: MerkletreeScanStatus.Complete, chain: CONFIG.chain, txidVersion: 'V3_PoseidonMerkle' as typeof VERSION })
  expect(() => requireWalletSync()).toThrow()
  expect(sdk.publish).not.toHaveBeenCalled()
  complete(); await pending
})

it('requires a reload after the scan deadline rather than overlapping a still-running SDK scan', async () => {
  vi.useFakeTimers()
  try {
    sdk.scan.mockImplementationOnce(async () => {})
    const pending = syncWallet(session)
    const refused = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await refused
    const calls = sdk.scan.mock.calls.length
    await expect(syncWallet(session)).rejects.toThrow(/Reload/)
    expect(sdk.scan).toHaveBeenCalledTimes(calls)
    expect(() => requireWalletSync()).toThrow()
  } finally { vi.useRealTimers() }
})
