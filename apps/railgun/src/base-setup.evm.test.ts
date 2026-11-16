import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FeeData, JsonRpcProvider, Transaction, Wallet, type JsonRpcSigner } from 'ethers'
import type { WalletSession } from './wallet'

const saved = vi.hoisted(() => new Map<string, unknown>())
vi.mock('./config', () => ({ CHAIN_ID: 8453, CHAIN: 8453n, CONFIG: {
  relayAdapt7702Contract: '0x0000000000000000000000000000000000001234',
  railgunRegistryContract: '0x0000000000000000000000000000000000005678',
} }))
vi.mock('./storage', () => ({ readPrivateState: async (_s: unknown, key: string) => structuredClone(saved.get(key)),
  writePrivateState: async (_s: unknown, key: string, value: unknown) => { saved.set(key, structuredClone(value)) },
  deletePrivateState: async (_s: unknown, key: string) => { saved.delete(key) } }))
vi.mock('@railgun-community/wallet', () => ({ fullWalletForID: () => ({ getEphemeralKeyIndex: async () => 0 }) }))
vi.mock('./shield', () => ({ assertPublicNetwork: async (_s: unknown, signer: JsonRpcSigner, before?: () => void) => {
  if ((await signer.provider.getNetwork()).chainId !== 8453n) throw new Error('Wrong local chain')
  before?.()
} }))
import { prepareBaseExecutionSetup, submitBaseExecutionSetup, checkBaseExecutionSetup,
  submitFundedBaseExecutionSetup, savedBaseExecutionSetup, baseAccountPrepared } from './base-setup'

// No fork, upstream URL or real wallet: this tests consensus nonce/delegation behavior on local Anvil.
describe.runIf(process.env.RAILGUN_LOCAL_EVM_TEST === '1')('local Base setup transaction execution', () => {
  let processHandle: ChildProcess | undefined, provider: JsonRpcProvider
  beforeAll(async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local port unavailable')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    processHandle = spawn(process.env.ANVIL_BIN || 'anvil', ['--host', '127.0.0.1', '--port', String(address.port),
      '--chain-id', '8453', '--hardfork', 'prague', '--base-fee', '0', '--silent'], { stdio: 'ignore' })
    let launchError: Error | undefined
    processHandle.on('error', error => { launchError = error })
    provider = new JsonRpcProvider(`http://127.0.0.1:${address.port}`, 8453, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 10 })
    let ready = false
    for (let attempt = 0; attempt < 30; attempt++) {
      if (launchError) throw launchError
      try { ready = await provider.send('eth_chainId', []) === '0x2105'; if (ready) break } catch {}
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!ready) throw new Error('Local Anvil did not start')
    // Local test doubles for registry/oracle/delegate; no assertion about Base mainnet fee rules.
    await provider.send('anvil_setCode', ['0x0000000000000000000000000000000000001234', '0x60005460005260206000f3'])
    await provider.send('anvil_setCode', ['0x0000000000000000000000000000000000005678', '0x61123460005260206000f3'])
    await provider.send('anvil_setCode', ['0x420000000000000000000000000000000000000F', '0x6103e860005260206000f3'])
    await provider.send('evm_mine', [])
    vi.spyOn(provider, 'getFeeData').mockResolvedValue(new FeeData(null, 10_000_000n, 1_000_000n))
  }, 10_000)
  afterAll(async () => {
    provider?.destroy()
    if (processHandle && processHandle.exitCode === null) {
      const closed = new Promise<void>(resolve => processHandle!.once('exit', () => resolve()))
      processHandle.kill('SIGTERM')
      await closed
    }
  })
  it('funds with type2, installs with local outer0/auth1 and reaches EOA2 with unspent execution nonce0', async () => {
    const account = Wallet.createRandom(), payer = Wallet.createRandom().connect(provider)
    await provider.send('anvil_setBalance', [payer.address, '0x2386f26fc10000'])
    const session = { info: { id: 'local-test-only' }, provider, accounts: {
      getAccount: async () => ({ address: account.address, signer: account }),
      getCurrentAccount: async () => ({ address: account.address, signer: account }),
    } } as unknown as WalletSession
    const review = await prepareBaseExecutionSetup(session, payer as unknown as JsonRpcSigner, { address: account.address, signer: account })
    const funding = await submitBaseExecutionSetup(session, payer as unknown as JsonRpcSigner, review)
    await provider.send('evm_mine', [])
    expect((await provider.getTransaction(funding))?.type).toBe(2)
    expect(await checkBaseExecutionSetup(session)).toMatchObject({ funded: true, ready: false })
    const setupHash = await submitFundedBaseExecutionSetup(session)
    await provider.send('evm_mine', [])
    expect(await checkBaseExecutionSetup(session)).toMatchObject({ hash: setupHash, ready: true })
    expect(await provider.getTransactionCount(account.address)).toBe(2)
    expect(await provider.getCode(account.address)).toBe('0xef01000000000000000000000000000000000000001234')
    const stored = await savedBaseExecutionSetup(session)
    if (stored?.version !== 2 || !stored.signedTransaction) throw new Error('Signed journal was not retained')
    const tx = Transaction.from(stored.signedTransaction)
    expect(tx.nonce).toBe(0)
    expect(tx.authorizationList?.[0].nonce).toBe(1n)
    expect(tx.from).toBe(account.address)
    expect(await baseAccountPrepared(session, account.address)).toBe(true)
    const receipt = await provider.getTransactionReceipt(setupHash)
    expect(receipt?.status).toBe(1)
    expect(receipt!.gasUsed).toBeLessThanOrEqual(46_000n)
    expect(await provider.getBalance(account.address)).toBeLessThan(BigInt(review.fundingAmount))
  }, 15_000)
})
