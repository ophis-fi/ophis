import { describe, expect, it, vi } from 'vitest'
import { Transaction, Wallet } from 'ethers'
import { prepaidForkFetch } from './prepaid-fork-transport.fixture'
import { createBnbBundle, protectedWriteRPC } from '../../railgun/operator/protected-submission'

const rpc = 'http://127.0.0.1:49152'
const guard = '0x1111111111111111111111111111111111111111'
const proxy = '0x2222222222222222222222222222222222222222'

async function fixture(chainId: number) {
  const operator = Wallet.createRandom(), account = Wallet.createRandom()
  const raw = await operator.signTransaction(chainId === 56
    ? { chainId, type: 4, to: guard, data: '0x1234', nonce: 0, gasLimit: 100_000n, maxFeePerGas: 50_000_000n,
      maxPriorityFeePerGas: 50_000_000n, authorizationList: [await account.authorize({ chainId, nonce: 0, address: proxy })] }
    : { chainId, type: 1, to: proxy, data: '0x1234', nonce: 0, gasLimit: 100_000n, gasPrice: 100_000n })
  const hash = Transaction.from(raw).hash!
  const body = chainId === 56 ? createBnbBundle(raw, { number: 100, timestamp: Math.floor(Date.now() / 1000) }, Date.now() + 60_000)
    : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
  const ownership = vi.fn(async () => {})
  const local = vi.fn(async () => {
    expect(ownership).toHaveBeenCalledOnce()
    return Response.json({ jsonrpc: '2.0', id: 1, result: hash })
  })
  const written = vi.fn(), pins = { rpc, chainId, operator: operator.address, guard, proxy,
    assertOwned: ownership, pendingHash: () => hash }
  const fetch = prepaidForkFetch(pins, local, () => false, written)
  return { raw, hash, body, local, ownership, written, pins, fetch }
}

describe('isolated prepaid fork protected-write boundary', () => {
  it.each([1, 56])('redirects chain%s exact journaled bytes only after ownership validation', async (chainId) => {
    const f = await fixture(chainId)
    const response = await f.fetch(protectedWriteRPC(chainId), { method: 'POST', body: f.body })
    expect(f.local).toHaveBeenCalledOnce()
    const [endpoint, options] = (f.local.mock.calls[0] as unknown as [string, RequestInit])
    expect(endpoint).toBe(rpc)
    expect(JSON.parse(String(options.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [f.raw] })
    const result = await response.json()
    expect(result.result).toMatch(/^0x[0-9a-f]{64}$/)
    if (chainId === 1) expect(result.result).toBe(f.hash)
    else {
      expect(result.result).not.toBe(f.hash)
      expect(f.written).toHaveBeenCalledWith(expect.objectContaining({ maxBlockNumber: 120 }))
    }
  })

  it('rejects a BNB revert allowlist or merge policy change without any network call', async () => {
    const f = await fixture(56)
    for (const extra of [{ revertingTxHashes: [f.hash] }, { noMerge: false }]) {
      const packet = JSON.parse(f.body)
      Object.assign(packet.params[0], extra)
      await expect(f.fetch(protectedWriteRPC(56), { method: 'POST', body: JSON.stringify(packet) })).rejects.toThrow('envelope')
    }
    expect(f.local).not.toHaveBeenCalled()
  })

  it('rejects wrong-chain endpoint, unjournaled bytes, and failed ownership before disclosure', async () => {
    const f = await fixture(56)
    await expect(f.fetch(protectedWriteRPC(1), { method: 'POST', body: f.body })).rejects.toThrow('selected fork chain')
    const unjournaled = prepaidForkFetch({ ...f.pins, pendingHash: () => undefined }, f.local, () => false, f.written)
    await expect(unjournaled(protectedWriteRPC(56), { method: 'POST', body: f.body })).rejects.toThrow('journal')
    f.ownership.mockRejectedValueOnce(new Error('owned process changed'))
    await expect(f.fetch(protectedWriteRPC(56), { method: 'POST', body: f.body })).rejects.toThrow('owned process changed')
    expect(f.local).not.toHaveBeenCalled()
  })

  it('blocks late private writes and an unrelated public RPC fallback', async () => {
    const f = await fixture(56)
    const closed = prepaidForkFetch(f.pins, f.local, () => true, f.written)
    await expect(closed(protectedWriteRPC(56), { method: 'POST', body: f.body })).rejects.toThrow('closed')
    await expect(f.fetch('https://example.invalid', { method: 'POST',
      body: JSON.stringify({ method: 'eth_sendRawTransaction', params: [f.raw] }) })).rejects.toThrow('Unexpected RPC write')
    expect(f.local).not.toHaveBeenCalled()
  })

  it('does not manufacture a successful acknowledgment for a local rejection', async () => {
    const f = await fixture(56)
    f.local.mockImplementationOnce(async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000 } }))
    await expect(f.fetch(protectedWriteRPC(56), { method: 'POST', body: f.body })).rejects.toThrow('exact signed transaction')
    expect(f.written).not.toHaveBeenCalled()
  })
})
