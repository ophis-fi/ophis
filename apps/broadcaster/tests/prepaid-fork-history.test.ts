import { expect, it } from 'vitest'
import { ABIRailgunSmartWallet } from '@railgun-community/engine'
import { id, Interface, ZeroAddress, ZeroHash } from 'ethers'
import { decodeBaseHistoryCache } from './prepaid-fork-history.fixture'

function fixture() {
  const abi = new Interface(ABIRailgunSmartWallet)
  const snapshot = { chainId: 8453, address: '0x1111111111111111111111111111111111111111', fromBlock: 100, toBlock: 200, blockHash: id('fork') }
  const token = { tokenType: 0, tokenAddress: '0x2222222222222222222222222222222222222222', tokenSubID: 0 }
  const raw = (name: string, args: unknown[], index: number) => ({ ...abi.encodeEventLog(abi.getEvent(name)!, args),
    address: snapshot.address, blockNumber: '0x96', blockHash: id('event block'), logIndex: `0x${index}`, transactionHash: id(`event ${index}`), removed: false })
  const cache = { version: 1, ...snapshot, logs: [
    raw('Shield', [0, 0, [{ npk: id('npk'), token, value: 99n }], [{ encryptedBundle: [ZeroHash, ZeroHash, ZeroHash], shieldKey: ZeroHash }], [1]], 0),
    raw('Nullified', [0, [id('spent')]], 1),
    raw('Transact', [0, 1, [id('commitment')], [{ ciphertext: [ZeroHash, ZeroHash, ZeroHash, ZeroHash],
      blindedSenderViewingKey: ZeroHash, blindedReceiverViewingKey: ZeroHash, annotationData: '0x', memo: '0x' }]], 2),
    raw('Unshield', [ZeroAddress, token, 98, 1], 3),
  ].reverse() }
  return { snapshot, cache }
}

it('decodes real ABI tuple and single-element array shapes with the installed SDK formatters', () => {
  const { snapshot, cache } = fixture(), events = decodeBaseHistoryCache(cache, snapshot)
  expect(events.commitmentEvents.map(event => event.startPosition)).toEqual([0, 1])
  expect(events.commitmentEvents[0].commitments).toHaveLength(1)
  expect(events.nullifierEvents).toHaveLength(1)
  expect(events.unshieldEvents).toHaveLength(1)
  expect(events.unshieldEvents[0]).toMatchObject({ blockNumber: 150, amount: '98', fee: '1' })
})

it.each(['chain', 'from', 'to', 'anchor', 'address', 'removed', 'range', 'duplicate', 'conflict'])('rejects %s history mismatch before SDK ingestion', mutation => {
  const { snapshot, cache } = fixture()
  if (mutation === 'chain') cache.chainId = 1
  if (mutation === 'from') cache.fromBlock++
  if (mutation === 'to') cache.toBlock++
  if (mutation === 'anchor') cache.blockHash = id('other fork')
  if (mutation === 'address') cache.logs[0].address = ZeroAddress
  if (mutation === 'removed') cache.logs[0].removed = true
  if (mutation === 'range') cache.logs[0].blockNumber = '0x64ff'
  if (mutation === 'duplicate') cache.logs.push(cache.logs[0])
  if (mutation === 'conflict') cache.logs[0].blockHash = id('other event block')
  expect(() => decodeBaseHistoryCache(cache, snapshot)).toThrow()
})
