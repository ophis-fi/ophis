import { describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { id, JsonRpcProvider, parseEther, toQuantity, Transaction, Wallet } from 'ethers'
import { Broadcaster } from '../src/broadcaster'
import { CreditLedger } from '../src/credit'
import { Store } from '../src/storage'
import { CHAIN, CHAIN_ID, settings } from '../src/config'
import { recover } from '../src/recovery'
import { accountingReport } from '../src/operations'
import { CREDIT_AUTHORIZATION_TYPES, CREDIT_PROTOCOL, creditAuthorizationValue, creditDomain, nativeCreditData } from '../../railgun/credit-protocol'

// Explicitly opt in: this owns a fresh local Anvil process; the public upstream is read-only.
// No wallet, key, RPC credential, browser profile or production state is read.
const enabled = process.env.OPHIS_NATIVE_PAYMENT_FORK === '1'
const upstreams: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  56: 'https://bsc-mainnet.public.blastapi.io',
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local test port.')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

describe.runIf(enabled && [1, 56].includes(CHAIN_ID))('owned native-payment fork', () => {
  it('proves finalized native funding, success/revert/cancellation and exact gas-funded liabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-native-fork-'))
    let child: ChildProcess | undefined, provider: JsonRpcProvider | undefined, store: Store | undefined
    try {
      const port = await unusedPort(), url = `http://127.0.0.1:${port}`
      child = spawn(join(homedir(), '.foundry/bin/anvil'), ['--host', '127.0.0.1', '--port', String(port),
        '--chain-id', String(CHAIN_ID), '--accounts', '0', '--silent', '--fork-url', upstreams[CHAIN_ID]],
      { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: homedir() } })
      let spawnFailed = false
      child.once('error', () => { spawnFailed = true })
      provider = new JsonRpcProvider(url, CHAIN, { batchMaxCount: 1, cacheTimeout: -1 })
      provider.pollingInterval = 100
      let instance = '', fork: Record<string, unknown> | undefined
      for (let attempt = 0; attempt < 150; attempt++) {
        if (spawnFailed || child.exitCode !== null) throw new Error('The owned Anvil process exited before becoming ready.')
        try {
          const metadata = await provider.send('anvil_metadata', [])
          if (metadata.forkedNetwork?.chainId !== CHAIN_ID || typeof metadata.instanceId !== 'string')
            throw new Error('The local instance is not the selected mainnet fork.')
          instance = metadata.instanceId
          fork = metadata.forkedNetwork
          break
        } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
      }
      if (!instance) throw new Error('Owned mainnet fork did not become ready.')
      const rpc = provider
      const owned = async () => {
        if (!child || child.exitCode !== null || !rpc ||
          (await rpc.send('anvil_metadata', [])).instanceId !== instance || (await rpc.getNetwork()).chainId !== CHAIN)
          throw new Error('The disposable fork identity changed; no write is permitted.')
      }
      const mutate = async (method: string, params: unknown[]) => { await owned(); return rpc.send(method, params) }
      const finalize = async () => {
        await mutate('anvil_setNextBlockBaseFeePerGas', [toQuantity(1_000_000_000n)])
        await mutate('anvil_mine', [70, 0])
      }
      const operator = Wallet.createRandom(), payer = Wallet.createRandom().connect(rpc)
      const initialReserve = parseEther('0.1'), deposit = parseEther('0.05'), net = parseEther('0.001')
      await mutate('anvil_setBalance', [operator.address, toQuantity(initialReserve)])
      await mutate('anvil_setBalance', [payer.address, toQuantity(parseEther('1'))])
      await finalize()
      store = new Store(directory)
      const journal = store
      const config = settings({ OPHIS_BROADCASTER_CHAIN_ID: String(CHAIN_ID), OPHIS_BROADCASTER_MODE: 'fork',
        OPHIS_BROADCASTER_ADMISSION: 'public', OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_RPC: url,
        OPHIS_BROADCASTER_CREDIT_PAYMENT_MODE: 'public-native', OPHIS_BROADCASTER_MARGIN_BPS: '1500',
        OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: '50000000000', OPHIS_BROADCASTER_MAX_TX_COST_WEI: parseEther('0.005').toString(),
        OPHIS_BROADCASTER_RESERVE_WEI: parseEther('0.05').toString(), OPHIS_BROADCASTER_DAILY_BUDGET_WEI: parseEther('0.05').toString() })
      const privateViewingKey = randomBytes(32), publicViewingKey = Buffer.from(await ed.getPublicKey(privateViewingKey)).toString('hex')
      const unsupported = async (): Promise<never> => { throw new Error('Private RAILGUN proof/collection is outside this native-only fixture.') }
      const sdk = { address: '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f',
        privateViewingKey, publicViewingKey, ready: () => true, sign: unsupported,
        fee: unsupported, validate: unsupported, assure: unsupported, validatePrepaid: unsupported }
      let mode: 'success' | 'revert' | 'cancel' = 'success', pending: { hash: string; nonce: number; cancellationHash?: string } | undefined
      const sender = {
        broadcastTransaction: async (raw: string) => {
          const tx = Transaction.from(raw)
          expect(journal.get(journal.pending()[0].key)?.raw).toBe(raw)
          if (mode === 'revert') await mutate('anvil_setCode', [tx.to!, '0x60006000fd'])
          if (mode === 'cancel') await mutate('evm_setAutomine', [false])
          pending = { hash: tx.hash!, nonce: tx.nonce }
          await owned()
          return rpc.broadcastTransaction(raw)
        },
        stageSigned: async (raw: string) => { const tx = Transaction.from(raw); pending = { hash: tx.hash!, nonce: tx.nonce }; return tx.hash! },
        stageRecovery: async () => { throw new Error('No historical rewind is expected in this fixture.') },
        pendingTransaction: () => pending,
        retryPending: async () => { throw new Error('The native-only fixture does not retry an original payout.') },
        cancelPending: async (raw: string) => {
          expect(journal.cancellations(journal.pending()[0].key).some(item => item.raw === raw)).toBe(true)
          await owned()
          const sent = await rpc.broadcastTransaction(raw)
          pending!.cancellationHash = sent.hash
          return sent.hash
        },
      }
      const service = new Broadcaster(config, journal, sdk, rpc, operator, sender, { rates: unsupported })
      const info = await service.creditInfo()
      const evidence: Array<Record<string, unknown>> = []
      let totalGas = 0n, totalPaid = 0n, totalFees = 0n
      for (const scenario of ['success', 'revert', 'cancel'] as const) {
        mode = scenario
        const owner = Wallet.createRandom(), recipient = Wallet.createRandom().address, paymentId = id(`native-${scenario}-${instance}`)
        const send = async (payload: Record<string, unknown>, expectedError = false) => {
          const encoded = JSON.stringify(payload), expires = Date.now() + 240_000
          const signature = await owner.signTypedData(creditDomain(info.scope, info.ledgerId), CREDIT_AUTHORIZATION_TYPES,
            creditAuthorizationValue(info.scope, owner.address, encoded, expires))
          const encrypted = await encryptDataWithSharedKey({ protocol: CREDIT_PROTOCOL, correlation: id(encoded), broadcasterViewingKey: publicViewingKey,
            authorization: { owner: owner.address, payload: encoded, expires, signature } }, Buffer.from(publicViewingKey, 'hex'))
          const response = await service.handle(Buffer.from(JSON.stringify({ method: 'transact', id: 1,
            params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } })))
          if (!response) throw new Error('No encrypted native response.')
          const decoded = tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(response).toString()).result, encrypted.sharedKey) as Record<string, unknown>
          if (!expectedError) expect(decoded.error).toBeUndefined()
          return decoded
        }
        await owned()
        const funding = await payer.sendTransaction({ to: operator.address, value: deposit, chainId: CHAIN, type: 2,
          nonce: await rpc.getTransactionCount(payer.address), data: nativeCreditData(info.scope, info.ledgerId, owner.address, paymentId) })
        await funding.wait()
        expect((await send({ kind: 'claim', transactionHash: funding.hash, paymentId }, true)).error).toBeDefined()
        expect(CreditLedger.load(journal).balance(owner.address).available).toBe(0n)
        await finalize()
        expect((await send({ kind: 'claim', transactionHash: funding.hash, paymentId })).available).toBe(deposit.toString())
        expect((await send({ kind: 'claim', transactionHash: funding.hash, paymentId })).available).toBe(deposit.toString())
        const ledger = CreditLedger.load(journal), quote = await send({ kind: 'quote', refund: true })
        const payload = { kind: 'refund', sequence: quote.nextSequence, recipient, net: net.toString(),
          gross: (net + BigInt(String(quote.maximumCharge))).toString(), feesID: quote.feesID,
          collectionAllowance: '0', refundGasAllowance: quote.refundGasAllowance }
        const before = await rpc.getBalance(operator.address), result = await send(payload)
        const originalHash = String(result.transactionHash), item = journal.pending()[0]
        expect(ledger.balance(owner.address).reserved).toBe(BigInt(payload.gross))
        expect((await send(payload)).transactionHash).toBe(originalHash)
        let settlementHash = originalHash
        if (scenario === 'cancel') {
          const original = Transaction.from(item.raw!)
          const fee = (original.maxFeePerGas! * 2n) > 2_000_000_000n ? original.maxFeePerGas! * 2n : 2_000_000_000n
          const tip = (original.maxPriorityFeePerGas! * 2n) > 1_000_000_000n ? original.maxPriorityFeePerGas! * 2n : 1_000_000_000n
          settlementHash = await recover('cancel', [fee.toString(), tip.toString()], config, journal, rpc, operator, sender)
          expect(BigInt(journal.get(item.key)!.max_cost)).toBeGreaterThan(BigInt(item.max_cost))
          await mutate('evm_setAutomine', [true])
          await mutate('anvil_mine', [1, 0])
        }
        await finalize()
        await service.reconcile()
        const receipt = await rpc.getTransactionReceipt(settlementHash)
        expect(receipt).toBeTruthy()
        const paid = scenario === 'success' ? net : 0n, gas = receipt!.gasUsed * receipt!.gasPrice
        const fee = (gas * 11_500n + 9_999n) / 10_000n
        expect(receipt!.status).toBe(scenario === 'revert' ? 0 : 1)
        expect(ledger.attempt(item.key)?.charged).toBe((paid + fee).toString())
        expect(ledger.balance(owner.address).available).toBe(deposit - paid - fee)
        expect(ledger.balance(owner.address).reserved).toBe(0n)
        expect(before - await rpc.getBalance(operator.address)).toBe(paid + gas)
        expect(await rpc.getBalance(recipient)).toBe(paid)
        expect((await send({ kind: 'refund-status', key: item.key })).state).toBe(scenario === 'success' ? 'refunded' : 'failed')
        totalGas += gas; totalPaid += paid; totalFees += fee
        evidence.push({ scenario, funding: funding.hash, original: originalHash, settlement: settlementHash,
          blockNumber: receipt!.blockNumber, blockHash: receipt!.blockHash,
          gasUsed: receipt!.gasUsed.toString(), gasPrice: receipt!.gasPrice.toString(), nativeExpense: gas.toString(),
          netPaid: paid.toString(), gasCharge: fee.toString(), status: receipt!.status })
      }
      const ledger = CreditLedger.load(journal), balance = await rpc.getBalance(operator.address)
      expect(balance).toBe(initialReserve + 3n * deposit - totalPaid - totalGas)
      expect(ledger.liability()).toBe(3n * deposit - totalPaid - totalFees)
      expect(balance - ledger.liability()).toBe(initialReserve + totalFees - totalGas)
      expect(ledger.earned()).toBe(totalFees - totalGas)
      expect(balance - ledger.liability()).toBeGreaterThan(initialReserve)
      const report = accountingReport(journal.db)
      expect(report.prepaidCredit?.funding).toBe('native')
      console.log(JSON.stringify({ kind: 'owned-native-fork-evidence', chainId: CHAIN_ID, instance, fork,
        upstream: upstreams[CHAIN_ID], mainnetWrites: 0, privateRailgunProofs: 0, protectedRouteQualification: false,
        operatorBalance: balance.toString(), customerLiability: ledger.liability().toString(),
        initialReserve: initialReserve.toString(), totalGas: totalGas.toString(), totalFees: totalFees.toString(),
        earnedMargin: ledger.earned().toString(), transactions: evidence }))
    } finally {
      store?.close(); provider?.destroy()
      if (child && child.exitCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>(resolve => { child!.once('exit', () => resolve()); setTimeout(resolve, 1_000) })
        if (child.exitCode === null) child.kill('SIGKILL')
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)
})
