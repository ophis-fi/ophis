import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { Interface, JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { PROTECTED_WRITE_RPC, ProtectedEthereumProvider } from './protected-provider'

const enabled = process.env.RAILGUN_PROTECTED_FORK_TEST === '1'
describe.skipIf(!enabled)('protected sender on an isolated Ethereum fork', () => {
  const originalFetch = globalThis.fetch
  let read: JsonRpcProvider
  let sender: ProtectedEthereumProvider
  let server: Server
  let directory: string
  let forkURL: string
  let readURL: string
  let leakedWrite = false
  const operator = Wallet.createRandom()

  beforeAll(async () => {
    forkURL = process.env.RAILGUN_FORK_RPC_URL ?? 'http://127.0.0.1:8559'
    const url = new URL(forkURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('This test requires an explicit loopback-only Anvil fork.')
    read = new JsonRpcProvider(forkURL, 1, { batchMaxCount: 1, cacheTimeout: -1 })
    read.pollingInterval = 100
    const metadata = await read.send('anvil_metadata', [])
    if (!metadata.forkedNetwork || (await read.getNetwork()).chainId !== 1n)
      throw new Error('Refusing to fund any account outside an Ethereum Anvil fork.')
    await read.send('anvil_setBalance', [operator.address, '0xde0b6b3a7640000'])
    directory = mkdtempSync(join(tmpdir(), 'ophis-protected-fork-'))
    server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const call = JSON.parse(body)
      response.setHeader('Content-Type', 'application/json')
      if (['anvil_metadata', 'hardhat_metadata'].includes(call.method)) {
        // Only this test disguises the fork; production still rejects known forks.
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } }))
        return
      }
      if (call.method.startsWith('eth_send')) {
        leakedWrite = true
        response.writeHead(500).end('Transaction leaked to the read connection.')
        return
      }
      const upstream = await originalFetch(forkURL, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
      response.end(await upstream.text())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local read shim missing.')
    readURL = `http://127.0.0.1:${address.port}`
    sender = new ProtectedEthereumProvider(readURL, operator.address, directory)
    vi.stubGlobal('fetch', vi.fn(async (endpoint: string, options: RequestInit) => {
      expect(endpoint).toBe(PROTECTED_WRITE_RPC)
      // Intercept every protected write and forward exclusively to the verified loopback fork.
      return originalFetch(forkURL, options)
    }))
  })

  afterAll(async () => {
    sender?.destroy(); read?.destroy(); vi.unstubAllGlobals()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('executes a signed EIP-7702 authorization through the protected writer without a public send', async () => {
    const config = NETWORK_CONFIG[NetworkName.Ethereum]
    expect(await read.getCode(config.relayAdapt7702Contract)).not.toBe('0x')
    const ephemeral = Wallet.createRandom()
    const authorization = await ephemeral.authorize({ chainId: 1, address: config.relayAdapt7702Contract, nonce: 0 })
    const block = await read.getBlock('latest')
    if (!block?.baseFeePerGas) throw new Error('Fork block has no base fee.')
    const raw = await operator.signTransaction({
      chainId: 1, type: 4, nonce: 0, to: ephemeral.address, authorizationList: [authorization],
      data: new Interface(['function adaptImplementation() view returns (address)']).encodeFunctionData('adaptImplementation'),
      value: 0n, gasLimit: 150_000n, maxFeePerGas: block.baseFeePerGas * 2n + 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
    const transaction = await sender.broadcastTransaction(raw)
    // Drive this isolated chain explicitly; it has no background production of blocks.
    await read.send('anvil_mine', ['0x1'])
    const receipt = await read.getTransactionReceipt(transaction.hash)
    expect(receipt?.status).toBe(1)
    expect(receipt?.type).toBe(4)
    expect((await read.getCode(ephemeral.address)).toLowerCase())
      .toBe(`0xef0100${config.relayAdapt7702Contract.slice(2)}`.toLowerCase())
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(leakedWrite).toBe(false)
    expect(sender.pendingTransaction()).toEqual({ hash: transaction.hash, nonce: 0 })
  }, 20_000)

  it('mines a private operator cancellation and permits the next nonce after two confirmations', async () => {
    const recoveryOperator = Wallet.createRandom()
    await read.send('anvil_setBalance', [recoveryOperator.address, '0xde0b6b3a7640000'])
    const recovery = new ProtectedEthereumProvider(readURL, recoveryOperator.address, directory)
    try {
      const block = await read.getBlock('latest')
      if (!block?.baseFeePerGas) throw new Error('Fork block has no base fee.')
      const transaction = { type: 2, chainId: 1, nonce: 0,
        to: NETWORK_CONFIG[NetworkName.Ethereum].proxyContract,
        data: new Interface(['function shieldFee() view returns (uint256)']).encodeFunctionData('shieldFee'),
        value: 0n, gasLimit: 150_000n, maxFeePerGas: block.baseFeePerGas * 2n + 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n }
      const original = await recoveryOperator.signTransaction(transaction)
      // Model a privately acknowledged transaction which has not landed anywhere.
      vi.mocked(globalThis.fetch).mockImplementationOnce(async (endpoint, options) => {
        expect(endpoint).toBe(PROTECTED_WRITE_RPC)
        const { params } = JSON.parse(options!.body as string)
        return Response.json({ jsonrpc: '2.0', id: 1, result: Transaction.from(params[0]).hash })
      })
      await recovery.send('eth_sendRawTransaction', [original])
      const signedCancellation = await recoveryOperator.signTransaction({ ...transaction,
        to: recoveryOperator.address, data: '0x', gasLimit: 21_000n })
      const cancellationHash = await recovery.cancelPending(signedCancellation)
      await read.send('anvil_mine', ['0x1'])
      const receipt = await read.getTransactionReceipt(cancellationHash)
      expect(receipt?.status).toBe(1)
      expect(receipt?.gasUsed).toBe(21_000n)
      expect(await read.getTransactionReceipt(Transaction.from(original).hash!)).toBeNull()
      await read.send('anvil_mine', ['0x1'])
      const next = await recoveryOperator.signTransaction({ ...transaction, nonce: 1 })
      const nextHash = await recovery.send('eth_sendRawTransaction', [next]) as string
      await read.send('anvil_mine', ['0x1'])
      expect((await read.getTransactionReceipt(nextHash))?.status).toBe(1)
      expect(recovery.pendingTransaction()).toEqual({ hash: nextHash, nonce: 1 })
      expect(leakedWrite).toBe(false)
    } finally { recovery.destroy() }
  }, 20_000)
})
