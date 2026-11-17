import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { Web3Provider } from '@ethersproject/providers'

import { createPublicClient, createWalletClient, custom, type Hex } from 'viem'
import { base, mainnet } from 'viem/chains'

import {
  appendOphisBaseBuilderCode,
  OPHIS_BASE_BUILDER_CODE,
  OPHIS_BASE_DATA_SUFFIX,
  withOphisBaseTransactionParams,
} from './baseBuilderCode'
import { OphisBaseProvider } from './OphisBaseProvider'
import { withOphisBasePublicClient, withOphisBaseWalletClient } from './withOphisBaseWalletClient'

const address = '0x1111111111111111111111111111111111111111'
const data = '0xd0e30db0'
const tagged = `${data}${OPHIS_BASE_DATA_SUFFIX.slice(2)}`
const hash = `0x${'12'.repeat(32)}`
const tx = { from: address, to: address, data, value: '0x1', gas: '0x10000', nonce: '0x4', chainId: '0x2105' }

describe('Ophis Base attribution', () => {
  it('uses attributed calldata for SDK viem public-client estimation too', async () => {
    const request = jest.fn(async () => '0x6000')
    const client = createPublicClient({ chain: base, transport: custom({ request }) })
    await withOphisBasePublicClient(client).estimateGas({ account: address, to: address, data })
    expect(request).toHaveBeenCalledWith({
      method: 'eth_estimateGas',
      params: [expect.objectContaining({ to: address, data: tagged })],
    })
    const other = createPublicClient({ chain: mainnet, transport: custom({ request }) })
    expect(withOphisBasePublicClient(other)).toBe(other)
  })
  it('pins the supplied builder code, byte length, schema and ERC-8021 marker', () => {
    const bytes = Buffer.from(OPHIS_BASE_DATA_SUFFIX.slice(2), 'hex')
    expect(bytes.length).toBe(29)
    expect(bytes.subarray(0, 11).toString('ascii')).toBe(OPHIS_BASE_BUILDER_CODE)
    expect(OPHIS_BASE_BUILDER_CODE).toBe('bc_8j4gt5x6')
    expect(bytes[11]).toBe(11)
    expect(bytes[12]).toBe(0)
    expect(bytes.subarray(13).toString('hex')).toBe('80218021802180218021802180218021')
  })

  it('is Base-only, immutable and idempotent', () => {
    expect(appendOphisBaseBuilderCode(data, 8453)).toBe(tagged)
    for (const chain of [1, 10, 130, 84532, 5042]) expect(appendOphisBaseBuilderCode(data, chain)).toBe(data)
    expect(appendOphisBaseBuilderCode(tagged as Hex, 8453)).toBe(tagged)
    expect(withOphisBaseTransactionParams('eth_sendTransaction', [tx], 8453)).toEqual([{ ...tx, data: tagged }])
    expect(tx.data).toBe(data)
  })

  it('preserves existing attribution, receive calls, deployment initcode and signed payloads', () => {
    const foreign = '0x1234567878010080218021802180218021802180218021'
    for (const input of ['0x', '0x12', foreign, tagged.toUpperCase().replace('0X', '0x')]) {
      expect(appendOphisBaseBuilderCode(input as Hex, 8453)).toBe(input)
    }
    const deployment = [{ data: '0x60806040', value: '0x0' }]
    expect(withOphisBaseTransactionParams('eth_sendTransaction', deployment, 8453)).toBe(deployment)
    for (const method of ['eth_signTypedData_v4', 'personal_sign', 'eth_sendRawTransaction', 'eth_call']) {
      const params = [tx]
      expect(withOphisBaseTransactionParams(method, params, 8453)).toBe(params)
    }
    expect(() => appendOphisBaseBuilderCode('0x12345', 8453)).toThrow('Invalid transaction calldata')
  })

  it('requests optional batch attribution without modifying calls or other capabilities', () => {
    const calls = [{ to: address, data, value: '0x1' }]
    const batch = {
      from: address,
      chainId: '0x2105',
      atomicRequired: true,
      calls,
      capabilities: { paymasterService: { url: 'https://example.com' } },
    }
    const result = withOphisBaseTransactionParams('wallet_sendCalls', [batch], 8453)
    expect(result).toEqual([
      {
        ...batch,
        capabilities: { ...batch.capabilities, dataSuffix: { value: OPHIS_BASE_DATA_SUFFIX, optional: true } },
      },
    ])
    expect((result[0] as typeof batch).calls).toBe(calls)
    const foreign = [{ ...batch, capabilities: { dataSuffix: { value: '0x1234', optional: false } } }]
    expect(withOphisBaseTransactionParams('wallet_sendCalls', foreign, 8453)).toBe(foreign)
  })

  it('sends the same bytes for legacy estimation and submission, retaining the raw iframe transport', async () => {
    const request = jest.fn(async ({ method }: { method: string; params?: unknown }) =>
      method === 'eth_chainId' ? '0x2105' : method === 'eth_estimateGas' ? '0x6000' : hash,
    )
    const raw = { request }
    const provider = new OphisBaseProvider(new Web3Provider(raw, 8453))
    expect(provider.provider).toBe(raw)
    await provider.send('eth_estimateGas', [tx, 'pending'])
    await provider.send('eth_sendTransaction', [tx])
    expect(request).toHaveBeenCalledWith({ method: 'eth_estimateGas', params: [{ ...tx, data: tagged }, 'pending'] })
    expect(request).toHaveBeenCalledWith({ method: 'eth_sendTransaction', params: [{ ...tx, data: tagged }] })
    const signed = [address, '{"message":"unchanged"}']
    await provider.send('eth_signTypedData_v4', signed)
    expect(request).toHaveBeenLastCalledWith({ method: 'eth_signTypedData_v4', params: signed })
  })

  it('refuses stale chains and mismatched explicit transaction chains before sending', async () => {
    const request = jest.fn(async () => '0xa')
    const provider = new OphisBaseProvider(new Web3Provider({ request }, 8453))
    await expect(provider.send('eth_sendTransaction', [tx])).rejects.toThrow('Wallet network changed')
    expect(request.mock.calls).toHaveLength(1)
    expect(() => withOphisBaseTransactionParams('eth_sendTransaction', [{ ...tx, chainId: '0xa' }], 8453)).toThrow(
      'Transaction network',
    )
  })

  it('preserves wallet rejections without retrying a write', async () => {
    const rejected = Object.assign(new Error('User rejected'), { code: 4001 })
    const request = jest.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x2105'
      if (method === 'eth_estimateGas') return '0x6000'
      throw rejected
    })
    const provider = new OphisBaseProvider(new Web3Provider({ request }, 8453))
    await expect(provider.send('eth_sendTransaction', [tx])).rejects.toBe(rejected)
    expect(request.mock.calls.filter(([arg]) => arg.method === 'eth_sendTransaction')).toHaveLength(1)
  })

  it('does not submit newly attributed calldata that reverts or exceeds a reviewed gas cap', async () => {
    for (const result of [new Error('execution reverted'), '0x10001']) {
      const request = jest.fn(async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x2105'
        if (result instanceof Error) throw result
        return result
      })
      const provider = new OphisBaseProvider(new Web3Provider({ request }, 8453))
      await expect(provider.send('eth_sendTransaction', [tx])).rejects.toThrow()
      expect(request.mock.calls.some(([arg]) => arg.method === 'eth_sendTransaction')).toBe(false)
    }
  })

  it('covers connected viem writes and optional batches, leaving other chains alone', async () => {
    const request = jest.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0x2105'
      if (method === 'eth_estimateGas') return '0x6000'
      if (method === 'wallet_sendCalls') return { id: hash }
      return hash
    })
    const client = createWalletClient({ account: address, chain: base, transport: custom({ request }) })
    const attributed = withOphisBaseWalletClient(client)
    await attributed.sendTransaction({ account: address, chain: base, to: address, data })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'eth_sendTransaction',
        params: [expect.objectContaining({ to: address, data: tagged })],
      }),
    )
    const calls = [{ to: address, data }]
    await attributed.sendCalls({ account: address, chain: base, calls })
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'wallet_sendCalls',
        params: [
          expect.objectContaining({
            calls,
            capabilities: { dataSuffix: { value: OPHIS_BASE_DATA_SUFFIX, optional: true } },
          }),
        ],
      }),
    )
    const other = createWalletClient({ account: address, chain: mainnet, transport: custom({ request }) })
    expect(withOphisBaseWalletClient(other)).toBe(other)
  })

  it('keeps attribution when viem falls back to wallet_sendTransaction', async () => {
    const request = jest.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0x2105'
      if (method === 'eth_estimateGas') return '0x6000'
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('Method not found'), { code: -32601 })
      return hash
    })
    const client = createWalletClient({ account: address, chain: base, transport: custom({ request }) })
    await withOphisBaseWalletClient(client).sendTransaction({ account: address, chain: base, to: address, data })
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_sendTransaction',
      params: [expect.objectContaining({ to: address, data: tagged })],
    })
  })

  it('tags raw estimation requests made by the installed CoW viem adapter', async () => {
    const request = jest.fn(async ({ method }: { method: string; params?: unknown }) =>
      method === 'eth_chainId' ? '0x2105' : method === 'eth_estimateGas' ? '0x6000' : hash,
    )
    const client = createPublicClient({ chain: base, transport: custom({ request }) })
    const wallet = createWalletClient({ account: address, chain: base, transport: custom({ request }) })
    const adapter = new ViemAdapter({
      provider: withOphisBasePublicClient(client),
      walletClient: withOphisBaseWalletClient(wallet),
    })
    const signer = adapter.signer
    if (!signer) throw new Error('Missing test signer')
    const gasLimit = await signer.estimateGas({ to: address, data })
    await signer.sendTransaction({ to: address, data, gasLimit })
    const transactionCalls = request.mock.calls
      .map(([call]) => call)
      .filter(({ method }) => ['eth_estimateGas', 'eth_sendTransaction'].includes(method))
    expect(transactionCalls.length).toBeGreaterThanOrEqual(3)
    for (const call of transactionCalls) {
      expect(call.params).toEqual([expect.objectContaining({ to: address, data: tagged })])
    }
  })
})
