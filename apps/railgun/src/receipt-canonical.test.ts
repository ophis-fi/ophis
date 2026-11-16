import { expect, it, vi } from 'vitest'
import { JsonRpcProvider, ZeroHash } from 'ethers'
import { assertCanonicalReceipt, readUncachedBlockHeader } from './receipt-canonical'

const receipt = { blockNumber: 123, blockHash: `0x${'ab'.repeat(32)}` }
type HeaderReader = (tag: number) => Promise<{ number: number; hash: string | null } | null>
const provider = (getBlock: HeaderReader) => ({ send: async (method: string, params: unknown[]) => {
  expect(method).toBe('eth_getBlockByNumber'); expect(params[1]).toBe(false)
  const block = await getBlock(Number(BigInt(String(params[0]))))
  return block && { ...block, number: `0x${block.number.toString(16)}` }
} }) as Pick<JsonRpcProvider, 'send'>

it('checks the canonical block at the existing receipt height without fetching a receipt again', async () => {
  const getBlock = vi.fn(async () => ({ number: 123, hash: receipt.blockHash.toUpperCase().replace('0X', '0x') }))
  await expect(assertCanonicalReceipt(provider(getBlock), receipt)).resolves.toBeUndefined()
  expect(getBlock).toHaveBeenCalledExactlyOnceWith(123)
})

it.each([null, { number: 122, hash: receipt.blockHash }, { number: 123, hash: ZeroHash },
  { number: 123, hash: null }, { number: 123, hash: `0x${'cd'.repeat(32)}` }])('rejects missing or replaced canonical block: %j', async block => {
  await expect(assertCanonicalReceipt(provider(vi.fn(async () => block)), receipt)).rejects.toThrow(/history changed|evidence is unavailable/)
})

it.each([{ ...receipt, blockNumber: -1 }, { ...receipt, blockNumber: NaN },
  { ...receipt, blockNumber: Number.MAX_SAFE_INTEGER + 1 }, { ...receipt, blockHash: ZeroHash },
  { ...receipt, blockHash: '0xab' }])('rejects malformed receipt evidence before any RPC: %j', async value => {
  const getBlock = vi.fn<HeaderReader>()
  await expect(assertCanonicalReceipt(provider(getBlock), value)).rejects.toThrow('evidence is unavailable')
  expect(getBlock).not.toHaveBeenCalled()
})

it('fails closed with a fixed diagnostic when the canonical read fails', async () => {
  const secret = 'https://provider.invalid/synthetic-secret'
  const getBlock = vi.fn<HeaderReader>().mockRejectedValue(new Error(secret))
  const result = assertCanonicalReceipt(provider(getBlock), receipt)
  await expect(result).rejects.toThrow('evidence is unavailable')
  await expect(result).rejects.not.toThrow(secret)
})

it('bypasses an actual ethers cached old block at the terminal canonicality check', async () => {
  const rpc = new JsonRpcProvider(undefined, 1, { staticNetwork: true })
  let reorg = false
  const send = vi.spyOn(rpc, 'send').mockImplementation(async () => ({ number: '0x7b',
    hash: reorg ? `0x${'cd'.repeat(32)}` : receipt.blockHash, parentHash: ZeroHash, timestamp: '0x1',
    nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1', gasUsed: '0x0', miner: null,
    extraData: '0x', transactions: [] }))
  try {
    await rpc.getBlock(receipt.blockNumber)
    reorg = true
    await expect(assertCanonicalReceipt(rpc, receipt)).rejects.toThrow('history changed')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('eth_getBlockByNumber', ['0x7b', false])
  } finally { rpc.destroy() }
})

it.each([undefined, {}, { number: '0x20000000000000', hash: receipt.blockHash },
  { number: '123', hash: receipt.blockHash }, { number: '0x7b', hash: '0xab' }])('rejects malformed raw header %j', async value => {
  await expect(readUncachedBlockHeader({ send: vi.fn(async () => value) }, 123)).rejects.toThrow('evidence is unavailable')
})
