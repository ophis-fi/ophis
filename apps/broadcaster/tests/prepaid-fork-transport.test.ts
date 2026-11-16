import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { id, toBeHex, Transaction, Wallet, type JsonRpcProvider } from 'ethers'
import { prepaidForkFetch, forkWriteRPC, forkPrepaidSender, forkSenderDiagnostic } from './prepaid-fork-transport.fixture'
import { createBnbBundle, protectedWriteRPC } from '../../railgun/operator/protected-submission'
import { createBaseValidityBody, prepareBaseValidity } from '../../railgun/operator/base-validity'

const rpc = 'http://127.0.0.1:49152'
const guard = '0x1111111111111111111111111111111111111111'
const proxy = '0x2222222222222222222222222222222222222222'

async function fixture(chainId: number) {
  const operator = Wallet.createRandom(), account = Wallet.createRandom()
  const raw = await operator.signTransaction(chainId === 56
    ? { chainId, type: 4, to: guard, data: '0x1234', nonce: 0, gasLimit: 100_000n, maxFeePerGas: 50_000_000n,
      maxPriorityFeePerGas: 50_000_000n, authorizationList: [await account.authorize({ chainId, nonce: 0, address: proxy })] }
    : chainId === 8453 ? { chainId, type: 2, to: guard, data: '0x1234', nonce: 0, gasLimit: 100_000n,
      maxFeePerGas: 100_000n, maxPriorityFeePerGas: 1n }
      : { chainId, type: 1, to: proxy, data: '0x1234', nonce: 0, gasLimit: 100_000n, gasPrice: 100_000n })
  const hash = Transaction.from(raw).hash!
  let body = chainId === 56 ? createBnbBundle(raw, { number: 100, timestamp: Math.floor(Date.now() / 1000) }, Date.now() + 60_000)
    : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
  if (chainId === 8453) {
    const head = { number: 100, timestamp: Math.floor(Date.now() / 1000), hash: id('owned Base head') }
    const words = [1_000_000_000n, (1000n << 96n) | (1000n << 64n), 1n, (7n << 64n) | 9n,
      0x8bde8f549f56d405f07e1aa15df9e1fc69839881n, 0x4f1db3c6abd250ba86e0928471a8f7db3afd88f1n, 0x01010101n]
    const provider = { getNetwork: async () => ({ chainId: 8453n }), getBlock: async () => head,
      send: async () => toBeHex(words.shift()!, 32) } as unknown as JsonRpcProvider
    const plan = await prepareBaseValidity(provider, Transaction.from(raw).unsignedSerialized, head.timestamp * 1000 + 60_000)
    body = createBaseValidityBody(raw, plan)
  }
  const ownership = vi.fn(async () => {})
  const local = vi.fn(async (_endpoint?: unknown, options?: RequestInit) => {
    expect(ownership).toHaveBeenCalledOnce()
    const call = JSON.parse(String(options?.body))
    if (call.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: 1, result: '0x64' })
    if (call.method === 'eth_getStorageAt') {
      const predicate = JSON.parse(body).params[1].validity.find((item: any) => item.params.address === call.params[0] && item.params.slot === call.params[1])
      return Response.json({ jsonrpc: '2.0', id: 1, result: toBeHex(BigInt(predicate.params.value), 32) })
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: hash })
  })
  const written = vi.fn(), pins = { rpc, chainId, operator: operator.address, guard, proxy,
    assertOwned: ownership, pendingHash: () => hash }
  const fetch = prepaidForkFetch(pins, local, () => false, written)
  return { raw, hash, body, local, ownership, written, pins, fetch }
}

describe('isolated prepaid fork protected-write boundary', () => {
  it.each([1, 56, 42161, 8453])('uses native canonical staging only for public-native fixture chain%s', async (chainId) => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-fork-native-mode-'))
    const operator = Wallet.createRandom(), originalFetch = globalThis.fetch
    const transport = await forkPrepaidSender({ rpc, chainId, operator: operator.address, guard, proxy, assertOwned: async () => {} }, directory)
    try {
      // Exercise the real sender's parsing and journal pipeline without an RPC.
      const raw = await operator.signTransaction({ chainId, type: 2, to: proxy, value: 1n, nonce: 0,
        gasLimit: 21_000n, maxFeePerGas: 100_000n, maxPriorityFeePerGas: 1n })
      const read = vi.spyOn(transport.sender as any, 'read').mockImplementation(async (method: unknown) => {
        if (method === 'anvil_metadata' || method === 'hardhat_metadata') return undefined
        if (method === 'eth_chainId') return toBeHex(chainId).replace(/^0x0+/, '0x')
        if (method === 'eth_blockNumber') return '0x64'
        throw new Error('Unexpected staging read in unit fixture.')
      })
      const pipeline = vi.spyOn(transport.sender as any, 'nativeNonceState').mockRejectedValue(new Error('native-canonical-pipeline-reached'))
      if ([42161, 8453].includes(chainId)) {
        await expect(transport.sender.stageSigned(raw)).rejects.toThrow('native-canonical-pipeline-reached')
        expect(pipeline).toHaveBeenCalledOnce()
      } else {
        await expect(transport.sender.stageSigned(raw)).rejects.toThrow('Only this operator')
        expect(pipeline).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
      }
    } finally { await transport.close(); globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }) }
  })

  it('retains bounded root exceptions without raw payloads, URLs or SDK error metadata', () => {
    const error = new Error(`Submission failed at https://example.invalid/credential ${'0x' + 'ab'.repeat(1024)}`,
      { cause: { code: -32000, message: 'nonce too low', data: 'excluded synthetic signed payload' } })
    const result = forkSenderDiagnostic(error)
    expect(result).toEqual([{ message: 'Submission failed at [url] [hex]' }, { code: '-32000', message: 'nonce too low' }])
    expect(JSON.stringify(result)).not.toContain('credential')
    const cyclic = { message: 'x'.repeat(1000), cause: undefined as unknown }; cyclic.cause = cyclic
    expect(forkSenderDiagnostic(cyclic)).toHaveLength(3)
    expect(forkSenderDiagnostic(cyclic).every((item) => item.message.length === 400)).toBe(true)
  })

  it.each([1, 56, 42161, 8453])('redirects chain%s exact journaled bytes only after ownership validation', async (chainId) => {
    const f = await fixture(chainId)
    const response = await f.fetch(forkWriteRPC(chainId), { method: 'POST', body: f.body })
    expect(f.local).toHaveBeenCalledTimes(chainId === 8453 ? 9 : 1)
    const [endpoint, options] = (f.local.mock.calls.at(-1) as unknown as [string, RequestInit])
    expect(endpoint).toBe(rpc)
    expect(JSON.parse(String(options.body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [f.raw] })
    const result = await response.json()
    expect(result.result).toMatch(/^0x[0-9a-f]{64}$/)
    if (chainId !== 56) expect(result.result).toBe(f.hash)
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

  it('rejects changed Base predicates and never forwards raw bytes to the public sequencer', async () => {
    const f = await fixture(8453), original = f.local.getMockImplementation()!
    f.local.mockImplementation(async (endpoint, options) => {
      const call = JSON.parse(String(options?.body))
      if (call.method === 'eth_getStorageAt') return Response.json({ jsonrpc: '2.0', id: 1, result: toBeHex(0n, 32) })
      return original(endpoint, options)
    })
    await expect(f.fetch(forkWriteRPC(8453), { method: 'POST', body: f.body })).rejects.toThrow('fee predicate changed')
    expect(f.written).not.toHaveBeenCalled()
    expect(f.local.mock.calls.every(([endpoint, options]) => endpoint === rpc &&
      JSON.parse(String(options?.body)).method !== 'eth_sendRawTransaction')).toBe(true)
    const changed = JSON.parse(f.body); changed.method = 'eth_sendRawTransaction'
    f.local.mockClear()
    await expect(f.fetch(forkWriteRPC(8453), { method: 'POST', body: JSON.stringify(changed) })).rejects.toThrow('validity envelope')
    expect(f.local).not.toHaveBeenCalled()
  })

  it('admits Base prices below their ceilings without relaxing exact configuration pins', async () => {
    const f = await fixture(8453), original = f.local.getMockImplementation()!
    f.local.mockImplementation(async (endpoint, options) => {
      const call = JSON.parse(String(options?.body))
      if (call.method === 'eth_getStorageAt') {
        const predicate = JSON.parse(f.body).params[1].validity.find((item: any) => item.params.address === call.params[0] && item.params.slot === call.params[1])
        if (predicate.params.op === '<=')
          return Response.json({ jsonrpc: '2.0', id: 1, result: toBeHex(BigInt(predicate.params.value) / 2n, 32) })
      }
      return original(endpoint, options)
    })
    const result = await f.fetch(forkWriteRPC(8453), { method: 'POST', body: f.body })
    expect((await result.json()).result).toBe(f.hash)
    expect(f.written).toHaveBeenCalledOnce()
  })

  it.each(['0x1', '0x7'])('rejects Base price above ceiling at slot%s before forwarding signed bytes', async slot => {
    const f = await fixture(8453), original = f.local.getMockImplementation()!
    f.local.mockImplementation(async (endpoint, options) => {
      const call = JSON.parse(String(options?.body))
      if (call.method === 'eth_getStorageAt' && call.params[1] === slot) {
        const predicate = JSON.parse(f.body).params[1].validity.find((item: any) => item.params.slot === slot)
        return Response.json({ jsonrpc: '2.0', id: 1, result: toBeHex(BigInt(predicate.params.value) + 1n, 32) })
      }
      return original(endpoint, options)
    })
    await expect(f.fetch(forkWriteRPC(8453), { method: 'POST', body: f.body })).rejects.toThrow('fee predicate changed')
    expect(f.written).not.toHaveBeenCalled()
    expect(f.local.mock.calls.every(([, options]) => JSON.parse(String(options?.body)).method !== 'eth_sendRawTransaction')).toBe(true)
  })
})
