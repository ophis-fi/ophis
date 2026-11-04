import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ refresh: vi.fn(), notes: vi.fn() }))
vi.mock('@railgun-community/wallet', async (original) => ({
  ...await original<object>(),
  refreshBalances: mocks.refresh,
  walletForID: () => ({ TXOs: mocks.notes }),
}))
import { RailgunSDK } from '../src/sdk'
import { config } from './request.fixture'
import { NETWORK, VERSION } from '../src/config'

it('confirms the exact received fee note and transaction without a PPOI service', async () => {
  const sdk = new RailgunSDK(config, {} as never, {} as never)
  sdk.walletId = 'test-operator'
  const hash = `0x${'12'.repeat(32)}`
  const proof = { commitment: `0x${'34'.repeat(32)}`, notePublicKey: `0x${'56'.repeat(32)}`,
    railgunTxid: `0x${'78'.repeat(32)}`, utxoTreeIn: 0, pois: {} }
  mocks.refresh.mockResolvedValue(undefined)
  mocks.notes.mockResolvedValue([])
  expect(await sdk.assure(hash, proof)).toBe(false)
  mocks.notes.mockResolvedValue([{ txid: hash, note: { hash: 1n } }])
  expect(await sdk.assure(hash, proof)).toBe(false)
  mocks.notes.mockResolvedValue([{ txid: `0x${'99'.repeat(32)}`, note: { hash: BigInt(proof.commitment) } }])
  expect(await sdk.assure(hash, proof)).toBe(false)
  mocks.notes.mockResolvedValue([{ txid: hash, note: { hash: BigInt(proof.commitment) } }])
  expect(await sdk.assure(hash, proof)).toBe(true)
  expect(mocks.refresh).toHaveBeenCalledWith(NETWORK.chain, ['test-operator'])
  expect(mocks.notes).toHaveBeenCalledWith(VERSION, NETWORK.chain)
})
