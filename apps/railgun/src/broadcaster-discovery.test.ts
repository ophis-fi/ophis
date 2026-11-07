import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SelectedBroadcaster } from '@railgun-community/shared-models'

const mocks = vi.hoisted(() => ({ started: false, start: vi.fn(), find: vi.fn() }))
vi.mock('./config', async (original) => {
  const config = await original<typeof import('./config')>()
  return { ...config, PROTECTED_BROADCASTERS: {
    [config.CHAIN_ID]: [{ railgunAddress: config.FEE_SIGNER, expiresAt: Number.MAX_SAFE_INTEGER }],
  } }
})
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({
  WakuBroadcasterClient: { isStarted: () => mocks.started, start: mocks.start, findBroadcastersForToken: mocks.find },
  BroadcasterTransaction: { create: vi.fn() },
}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'ethereum')
  mocks.started = false
  mocks.start.mockReset().mockImplementation(async () => { mocks.started = true })
  mocks.find.mockReset().mockReturnValue([])
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

async function candidate(): Promise<SelectedBroadcaster> {
  const { CONFIG, FEE_SIGNER, TOKENS } = await import('./config')
  return {
    railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
    tokenFee: { expiration: Date.now() + 120_000, feesID: 'verified-test-fee', feePerUnitGas: '10',
      availableWallets: 1, relayAdapt: '', relayAdapt7702: CONFIG.relayAdapt7702Contract, reliability: 1 },
  }
}

it('starts discovery automatically and waits for an actual compatible fee, not just SDK startup', async () => {
  const selected = await candidate()
  const { selectBroadcaster } = await import('./broadcaster')
  const status = vi.fn()
  const pending = selectBroadcaster(selected.tokenAddress, true, status)
  let settled = false
  void pending.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(settled).toBe(false)
  mocks.find.mockReturnValue([selected])
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toBe(selected)
  expect(mocks.find).toHaveBeenCalledWith(expect.anything(), selected.tokenAddress, true, true)
  expect(status).toHaveBeenLastCalledWith('A fresh compatible broadcaster fee is ready.')
})

it('keeps the 60-second freshness and canonical delegate guards while waiting for a valid fee', async () => {
  const selected = await candidate()
  const invalid = [
    { ...selected, tokenFee: { ...selected.tokenFee, expiration: Date.now() - 1 } },
    { ...selected, tokenFee: { ...selected.tokenFee, expiration: Date.now() + 60_000 } },
    { ...selected, tokenFee: { ...selected.tokenFee, relayAdapt7702: '0x0000000000000000000000000000000000000001' } },
    { ...selected, railgunAddress: 'unapproved-operator', tokenFee: { ...selected.tokenFee, feePerUnitGas: '1' } },
  ]
  mocks.find.mockReturnValue(invalid)
  const { selectBroadcaster } = await import('./broadcaster')
  const pending = selectBroadcaster(selected.tokenAddress, true, vi.fn())
  await vi.advanceTimersByTimeAsync(1000)
  mocks.find.mockReturnValue([...invalid, selected])
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toBe(selected)
})

it('does not fall back to an unapproved operator when the protected operator disappears', async () => {
  const selected = await candidate()
  mocks.find.mockReturnValue([{ ...selected, railgunAddress: 'unapproved-operator' }])
  const { selectBroadcaster } = await import('./broadcaster')
  const pending = selectBroadcaster(selected.tokenAddress, true, vi.fn())
  const rejected = expect(pending).rejects.toThrow('No verified compatible broadcaster fee arrived')
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
})

it('rejects a saved Ethereum proof for a retired operator immediately and points to public-wallet recovery', async () => {
  const selected = await candidate()
  const { selectBroadcaster } = await import('./broadcaster')
  const status = vi.fn()
  await expect(selectBroadcaster(selected.tokenAddress, false, status,
    '0zk1qyjex88m96zw2kunzxw8r8g7007ak2qe082w5n0f038chhhkzfcdtrv7j6fe3z53law92j4q28j34xsacfqf9kmqw20ap8ek904q7j0hjllh8rpd3t96jq7xh98'))
    .rejects.toThrow(/saved proof.*retired Ethereum broadcaster.*Keep it and use public-wallet recovery/)
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.find).not.toHaveBeenCalled()
  expect(status).not.toHaveBeenCalled()
})

it('times out without weakening fee checks and can use a fresh common withdrawal fee on retry', async () => {
  const selected = await candidate()
  const { selectBroadcaster } = await import('./broadcaster')
  const status = vi.fn()
  const pending = selectBroadcaster(selected.tokenAddress, false, status)
  const rejected = expect(pending).rejects.toThrow('No verified compatible broadcaster fee arrived')
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
  mocks.find.mockReturnValue([{ ...selected, tokenFee: { ...selected.tokenFee, relayAdapt7702: undefined } }])
  expect(await selectBroadcaster(selected.tokenAddress, false, status)).toMatchObject({ tokenAddress: selected.tokenAddress })
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.find).toHaveBeenLastCalledWith(expect.anything(), selected.tokenAddress, false, false)
})

it('shares an in-flight startup and retries an initialization failure', async () => {
  const { startBroadcasters } = await import('./broadcaster')
  mocks.start.mockRejectedValueOnce(new Error('Network unavailable'))
  await expect(startBroadcasters(vi.fn())).rejects.toThrow('Network unavailable')
  let finish: (() => void) | undefined
  mocks.start.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = () => { mocks.started = true; resolve() }
  }))
  const first = startBroadcasters(vi.fn())
  const second = startBroadcasters(vi.fn())
  expect(mocks.start).toHaveBeenCalledTimes(2)
  finish?.()
  await Promise.all([first, second])
})

it('bounds a stalled startup and reuses it safely if a retry begins before it finally connects', async () => {
  const { startBroadcasters } = await import('./broadcaster')
  let finish: (() => void) | undefined
  mocks.start.mockImplementationOnce(() => new Promise<void>((resolve) => {
    finish = () => { mocks.started = true; resolve() }
  }))
  const status = vi.fn()
  const first = startBroadcasters(status)
  const rejected = expect(first).rejects.toThrow('connection timed out')
  await vi.advanceTimersByTimeAsync(45_000)
  await rejected
  expect(status).toHaveBeenLastCalledWith(expect.stringContaining('connection timed out'))
  const second = startBroadcasters(status)
  expect(mocks.start).toHaveBeenCalledTimes(1)
  finish?.()
  await second
})
