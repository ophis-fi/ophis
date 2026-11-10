/// <reference path="../../railgun/node_modules/vite/client.d.ts" />
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, statfsSync, writeFileSync } from 'node:fs'
import LevelDOWN from 'leveldown'
import { Contract, ContractFactory, JsonRpcProvider, Wallet, Transaction, Mnemonic, getAddress, hexlify, randomBytes, ZeroAddress, ZeroHash } from 'ethers'
import { EngineEvent, POI, TransactionBatch, TransactNote, OutputType, RailgunEngine, getTokenDataERC20, type QuickSyncEvents } from '@railgun-community/engine'
import { ArtifactStore, startRailgunEngine, loadProvider, unloadProvider, getEngine, getProver,
  createRailgunWallet, fullWalletForID, viewOnlyWalletForID, EphemeralKeyManager, refreshBalances,
  balanceForERC20Token, populateShieldBaseToken, gasEstimateForUnprovenTransfer, generateTransferProof, populateProvedTransfer,
  gasEstimateForUnprovenCrossContractCalls7702, generateCrossContractCallsProof7702, populateProvedCrossContractCalls,
  generateUnshieldProof, populateProvedUnshield, gasEstimateForUnprovenUnshield, ratchetEphemeralAddress,
  encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey, getRailgunWalletAddressData, setLoggers,
  type SnarkJSGroth16 } from '@railgun-community/wallet'
import { groth16 } from 'snarkjs'
import { EVMGasType, calculateGasLimit, calculateMaximumGas, getEVMGasTypeForTransaction,
  type TransactionGasDetails, type TransactionGasDetailsType4 } from '@railgun-community/shared-models'
import { CHAIN, CHAIN_ID, NETWORK, NETWORK_NAME, TOKENS, VERSION, settings } from '../src/config'
import { Store, initializeSecrets, readSecrets } from '../src/storage'
import { RailgunSDK } from '../src/sdk'
import { Broadcaster } from '../src/broadcaster'
import { CreditLedger, creditCharge } from '../src/credit'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { accountingReport } from '../src/operations'
import { creditBackingEvidence } from '../src/credit-backing'
import { ANON_COLLECTION_ABI, ANON_COLLECTION_GATEWAY, readAnonCollectionBaseFee } from '../src/anon-native-collection'
import { GUARD_ARTIFACT } from '../../railgun/operator/execution-guard-artifact'
import { CREDIT_PROTOCOL, CREDIT_AUTHORIZATION_TYPES, CREDIT_REQUEST_LIFETIME, creditAuthorizationValue,
  creditDomain, creditMemo, type CreditScope } from '../../railgun/credit-protocol'
import { disablePPOI } from '../../railgun/poi-policy'
import { quoteSwap, unshieldAmount } from '../../railgun/src/recipe'
import { PROXY, WRAPPED_SYMBOL, CHAIN_ID as CLIENT_CHAIN_ID } from '../../railgun/src/config'
import { ADAPT, assertBoundWithdrawal, assertSameExecution, encodeRequest } from '../../railgun/src/execution'
import type { WalletSession } from '../../railgun/src/wallet'
import { forkPrepaidSender } from './prepaid-fork-transport.fixture'

// Separate synthetic fixture: never import it from a production entry point.
// Uses real SDK proofs and the real fee-wallet note/receipt/backing validators.
export async function prepaidFork(input: { rpc: string; root: string; forkBlock: number;
  assertOwned: () => Promise<void>; progress: (phase: string, details?: unknown) => void }) {
  assert([1, 56].includes(CHAIN_ID), 'Only the separate Ethereum and BNB prepaid fixtures are supported.')
  assert.equal(CLIENT_CHAIN_ID, CHAIN_ID, 'The client helpers and backend must use the same immutable chain.')
  assert.equal(new URL(input.rpc).hostname, '127.0.0.1')
  await input.assertOwned()
  const provider = new JsonRpcProvider(input.rpc, CHAIN_ID, { cacheTimeout: -1, batchMaxCount: 1 })
  const originalSend = provider.send.bind(provider)
  provider.send = async (method: string, params: unknown[]) => {
    if (/^(anvil_|evm_|eth_send|eth_sign|personal_)/.test(method) && method !== 'anvil_metadata') await input.assertOwned()
    try { return await originalSend(method, params) }
    catch (error) {
      input.progress('owned-rpc-error', { method, message: String(error).slice(0, 4000) })
      throw error
    }
  }
  const root = join(input.root, 'synthetic-state'); mkdirSync(root, { recursive: true, mode: 0o700 })
  initializeSecrets(join(root, 'operator.json'), 'fork')
  const secrets = readSecrets(join(root, 'operator.json'))
  const store = new Store(root)
  const bnb = CHAIN_ID === 56
  const config = settings({ OPHIS_BROADCASTER_CHAIN_ID: String(CHAIN_ID), OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_RPC: input.rpc,
    OPHIS_BROADCASTER_ADMISSION: 'public', OPHIS_BROADCASTER_ENABLED: '1', OPHIS_BROADCASTER_STATE: root,
    OPHIS_BROADCASTER_MARGIN_BPS: '1500', OPHIS_BROADCASTER_MAX_GAS_PRICE_WEI: bnb ? '100000000' : '500000000',
    OPHIS_BROADCASTER_MAX_TX_COST_WEI: bnb ? '250000000000000' : '1500000000000000',
    OPHIS_BROADCASTER_DAILY_BUDGET_WEI: bnb ? '450000000000000' : '1500000000000000',
    OPHIS_BROADCASTER_RESERVE_WEI: bnb ? '17500000000000000' : '1500000000000000',
    OPHIS_BROADCASTER_CREDIT_COLLECTION_GAS: '2000000', OPHIS_BROADCASTER_CREDIT_COLLECTION_INPUTS: '1',
    OPHIS_BROADCASTER_CREDIT_COLLECTION_OUTPUTS: '3', OPHIS_BROADCASTER_CREDIT_COLLECTION_PROOFS: '1' })
  const sdk = new RailgunSDK(config, secrets, store)
  const operator = new Wallet(secrets.gasKey, provider)
  store.bindIdentity(CHAIN_ID, operator.address)
  let transport: Awaited<ReturnType<typeof forkPrepaidSender>> | undefined
  let loaded = false, signatures = 0, submissions = 0
  let inclusionFailure: 'revert' | 'out-of-gas' | undefined
  const results: Record<string, unknown> = { passed: false, chainId: CHAIN_ID, proofMode: 'real-sdk', proofsCompleted: 0,
    livePPOI: false, livePrivateRelay: false, singleEngineSyntheticWallets: true, operations: [] }
  const operations = results.operations as Record<string, unknown>[]
  const log = (phase: string, details?: unknown) => input.progress(phase, details)
  const stage = async <T>(name: string, work: () => Promise<T>, milliseconds = 120_000): Promise<T> => {
    log(`${name}-start`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Isolated fixture timed out in ${name}.`)), milliseconds)
      })])
      log(`${name}-complete`); return value
    } finally { clearTimeout(timer) }
  }
  const progress = (percent: number, status: string) => { if (percent === 0 || percent === 100) log('proof', { status, percent }) }
  const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)
  const artifacts = new Map<string, unknown>()
  let artifactBytes = 0
  const refresh = async (...ids: string[]) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!getEngine().getUTXOMerkletree(VERSION, NETWORK.chain).isScanning) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await refreshBalances(NETWORK.chain, ids)
    assert(sdk.ready(), 'A completed real SDK scan is required.')
  }
  const finalized = async (hash: string, expectedStatus = 1) => {
    // Model local finality without pushing the owned fork's clock ahead of wall time.
    await provider.send('anvil_mine', [70, 0])
    const receipt = await provider.getTransactionReceipt(hash)
    if (receipt) appendFileSync(join(input.root, 'receipts.jsonl'), json(receipt.toJSON()) + '\n', { mode: 0o600 })
    assert.equal(receipt?.status, expectedStatus)
    assert((await provider.getBlock('finalized'))!.number >= receipt!.blockNumber)
    return receipt!
  }
  try {
    const usdc = TOKENS.find((token) => token.symbol === 'USDC')!
    assert.equal(TOKENS[0].symbol, WRAPPED_SYMBOL)
    assert.equal(usdc.decimals, bnb ? 18 : 6)
    for (const token of [TOKENS[0], usdc]) {
      const decimals = await new Contract(token.address, ['function decimals() view returns(uint8)'], provider).decimals()
      assert.equal(Number(decimals), token.decimals, 'Snapshot token decimals must match the selected chain metadata.')
    }
    results.tokens = [TOKENS[0], usdc]
    results.limits = { maxGasPrice: config.maxGasPrice.toString(), maxTransactionCost: config.maxTransactionCost.toString(),
      dailyBudget: config.dailyBudget.toString(), reserve: config.reserve.toString() }
    log('guard-deployment')
    await provider.send('anvil_setBalance', [operator.address, '0x56bc75e2d63100000'])
    const guard = await new ContractFactory(GUARD_ARTIFACT.abi, GUARD_ARTIFACT.bytecode, operator)
      .deploy(operator.address, NETWORK.relayAdapt7702Contract, ...(bnb ? [{ gasPrice: 50_000_000n }] : []))
    await finalized(guard.deploymentTransaction()!.hash)
    await guard.waitForDeployment(); config.executionGuard = await guard.getAddress()
    transport = await forkPrepaidSender({ rpc: input.rpc, chainId: CHAIN_ID, operator: operator.address,
      guard: config.executionGuard, proxy: NETWORK.proxyContract, assertOwned: input.assertOwned }, root)
    log('engine-start')
    disablePPOI(POI, NETWORK)
    await startRailgunEngine('prepaidtest', new LevelDOWN(join(root, 'wallet-db')), false,
      new ArtifactStore(async (path) => {
        if (!artifacts.has(path)) throw new Error('Public artifact is not cached.')
        return artifacts.get(path) as never
      }, async (_dir, path, data) => {
        artifacts.set(path, data)
        artifactBytes += typeof data === 'string' ? Buffer.byteLength(data) : (data as Uint8Array).byteLength
        assert(artifactBytes < 1024 ** 3, 'Synthetic in-memory artifact cache exceeded 1GiB.')
        log('public-artifact-cached', { bytes: artifactBytes })
      }, async (path) => artifacts.has(path)), false, false)
    getProver().setSnarkJSGroth16(groth16 as unknown as SnarkJSGroth16)
    // The public indexer is ahead of this owned snapshot. Keep only historical events.
    const engine = getEngine(), quick = engine.quickSyncEvents.bind(engine)
    engine.on(EngineEvent.UTXOMerkletreeHistoryScanUpdate, (event) => {
      log('public-history-scan', { status: event.scanStatus, progress: event.progress })
    })
    const bounded: QuickSyncEvents = async (...args) => {
      log('public-indexer-query', { startingBlock: args[2] })
      const events = await quick(...args)
      log('public-indexer-result', Object.fromEntries(Object.entries(events).map(([key, values]) => [key, values.length])))
      return Object.fromEntries(Object.entries(events).map(([key, values]) => [key,
        (values as { blockNumber: number }[]).filter((event) => event.blockNumber <= input.forkBlock)])) as Awaited<ReturnType<QuickSyncEvents>>
    }
    Object.defineProperty(engine, 'quickSyncEvents', { value: bounded })
    await sdk.start()
    const feeFullId = sdk.walletId, feeFullKey = secrets.encryptionKey
    // These keys were generated by this invocation, before any synthetic note exists.
    const creationBlocks: number[][] = []
    creationBlocks[NETWORK.chain.type] = []
    creationBlocks[NETWORK.chain.type][CHAIN_ID] = input.forkBlock
    fullWalletForID(feeFullId).testSpecificSetCreationBlockNumbers(creationBlocks)
    const feeView = await sdk.prepareViewOnly(hexlify(randomBytes(32)).slice(2))
    sdk.walletId = feeView.id
    viewOnlyWalletForID(sdk.walletId).testSpecificSetCreationBlockNumbers(creationBlocks)
    const userKey = hexlify(randomBytes(32)).slice(2)
    const user = await createRailgunWallet(userKey, Mnemonic.fromEntropy(randomBytes(16)).phrase, { [NETWORK_NAME]: input.forkBlock })
    const accounts = new EphemeralKeyManager(fullWalletForID(user.id), userKey)
    const claimant = (await accounts.getAccount(CHAIN, 0)).signer
    // Default Anvil accounts can already have mainnet 7702 delegation; synthetic funding must not inherit it.
    const publicGas = Wallet.createRandom().connect(provider)
    await provider.send('anvil_setBalance', [publicGas.address, '0x56bc75e2d63100000'])
    assert.equal(await provider.getCode(publicGas.address), '0x')
    const operatorNativeBefore = await provider.getBalance(operator.address)
    assert.notEqual(getAddress(await publicGas.getAddress()), claimant.address)
    log('public-history-sync')
    // Only this disposable fixture exposes diagnostics, before any private transfer exists.
    setLoggers(() => {}, (error: unknown) => log('public-history-error', { message: String(error).slice(0, 4000) }))
    await loadProvider({ chainId: CHAIN_ID, providers: [{ provider: input.rpc, priority: 1, weight: 2, maxLogsPerBatch: 1000 }] }, NETWORK_NAME, 1000)
    loaded = true
    await refresh(user.id, sdk.walletId)
    setLoggers(() => {}, () => {})
    const sender = { broadcastTransaction: async (raw: string, expires?: number) => {
      await input.assertOwned()
      const tx = Transaction.from(raw), row = store.pending().find((item) => item.raw === raw && item.hash === tx.hash)
      assert(row, 'Signed bytes must be journaled before disclosure.')
      assert.equal(JSON.parse(row.fee_data).kind, 'prepaid')
      submissions++
      const failure = inclusionFailure
      inclusionFailure = undefined
      const originalCode = failure ? await provider.getCode(NETWORK.proxyContract) : undefined
      try {
        // Inject only after successful real proof tracing and durable signing on our owned fork.
        if (failure) await provider.send('anvil_setCode', [NETWORK.proxyContract, failure === 'revert' ? '0x60006000fd' : '0x5b600056'])
        const response = await transport!.sender.broadcastTransaction(raw, expires)
        const receipt = await finalized(response.hash, failure ? 0 : 1)
        if (failure === 'out-of-gas') assert.equal(receipt.gasUsed, tx.gasLimit)
        return response
      } finally {
        if (originalCode) await provider.send('anvil_setCode', [NETWORK.proxyContract, originalCode])
      }
    } }
    const service = new Broadcaster(config, store, sdk, provider, { address: operator.address,
      signTransaction: async (tx) => { signatures++; return operator.signTransaction(tx) } }, sender, { rates: async () => ({}) })
    let scope: CreditScope, ledgerId: string
    const request = async (payload?: Record<string, unknown>) => {
      const correlation = hexlify(randomBytes(32))
      const data: Record<string, unknown> = { protocol: CREDIT_PROTOCOL, correlation, broadcasterViewingKey: sdk.publicViewingKey }
      if (!payload) data.kind = 'info'
      else {
        const encoded = json(payload), expires = Date.now() + CREDIT_REQUEST_LIFETIME
        const signature = await claimant.signTypedData(creditDomain(scope, ledgerId), CREDIT_AUTHORIZATION_TYPES,
          creditAuthorizationValue(scope, claimant.address, encoded, expires))
        data.authorization = { owner: claimant.address, payload: encoded, expires, signature }
      }
      const encrypted = await encryptDataWithSharedKey(data, getRailgunWalletAddressData(sdk.address).viewingPublicKey)
      const packet = Buffer.from(json({ method: 'transact', id: correlation,
        params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }))
      const response = await service.handle(packet)
      assert(response, 'The actual backend must return an encrypted response.')
      const decoded = tryDecryptJSONDataWithSharedKey(JSON.parse(Buffer.from(response).toString()).result, encrypted.sharedKey) as Record<string, any>
      assert.equal(decoded.correlation, correlation); assert.equal(decoded.protocol, CREDIT_PROTOCOL)
      if (decoded.error) throw new Error(`Backend rejected synthetic request: ${decoded.error}`)
      return decoded
    }
    const info = await request(); scope = info.scope; ledgerId = info.ledgerId
    log('synthetic-native-shield')
    const shield = await populateShieldBaseToken(VERSION, NETWORK_NAME, user.railgunAddress, hexlify(randomBytes(32)),
      { tokenAddress: TOKENS[0].address, amount: 20_000_000_000_000_000n })
    const shieldTx = await publicGas.sendTransaction(bnb ? { ...shield.transaction, type: 0, gasPrice: 50_000_000n,
      maxFeePerGas: undefined, maxPriorityFeePerGas: undefined } : shield.transaction)
    await finalized(shieldTx.hash)
    operations.push({ kind: 'shield', hash: shieldTx.hash })
    await refresh(user.id, sdk.walletId)
    const userBalance = (token = TOKENS[0].address) => balanceForERC20Token(VERSION, fullWalletForID(user.id), NETWORK_NAME, token, true)
    assert.equal(await userBalance(), 19_950_000_000_000_000n)
    log('real-topup-proof')
    const topupAmount = bnb ? 2_000_000_000_000_000n : 10_000_000_000_000_000n
    const memo = creditMemo(scope, ledgerId, claimant.address)
    // The initial qualified owner route spends one accounted note and returns at most one change note.
    const recipients = [{ tokenAddress: TOKENS[0].address, amount: topupAmount, recipientAddress: sdk.address }]
    const publicFees = await provider.getFeeData()
    if (bnb) assert(publicFees.gasPrice! > 0n && publicFees.gasPrice! <= config.maxGasPrice, 'The owned BNB simulator must fit its unchanged gas cap.')
    const publicGasDetails: TransactionGasDetails = getEVMGasTypeForTransaction(NETWORK_NAME, true) === EVMGasType.Type0
      ? { evmGasType: EVMGasType.Type0, gasEstimate: 3_000_000n, gasPrice: publicFees.gasPrice! }
      : { evmGasType: EVMGasType.Type2, gasEstimate: 3_000_000n,
        maxFeePerGas: publicFees.maxFeePerGas!, maxPriorityFeePerGas: publicFees.maxPriorityFeePerGas! }
    const topupEstimate = await stage('topup-gas-estimate', () => gasEstimateForUnprovenTransfer(VERSION, NETWORK_NAME, user.id, userKey, memo, recipients, [], publicGasDetails, undefined, true))
    await stage('topup-real-proof', () => generateTransferProof(VERSION, NETWORK_NAME, user.id, userKey, false, memo, recipients, [], undefined, true, 0n, progress), 180_000)
    results.proofsCompleted = Number(results.proofsCompleted) + 1
    const topup = await populateProvedTransfer(VERSION, NETWORK_NAME, user.id, false, memo, recipients, [], undefined, true, 0n,
      { ...publicGasDetails, gasEstimate: topupEstimate.gasEstimate })
    const topupTx = await publicGas.sendTransaction(topup.transaction), topupReceipt = await finalized(topupTx.hash)
    await refresh(user.id, sdk.walletId)
    const claim = await request({ kind: 'claim', transactionHash: topupTx.hash })
    const firstClaimCompletedAt = performance.now()
    assert.equal(BigInt(claim.available), topupAmount)
    const duplicate = await request({ kind: 'claim', transactionHash: topupTx.hash })
    assert.equal(duplicate.available, claim.available)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM credit_deposits').get()!.count, 1)
    operations.push({ kind: 'topup', hash: topupTx.hash, amount: topupAmount.toString(), notes: 1,
      gasUsed: topupReceipt.gasUsed.toString(), realSdkClaim: true, duplicateIdempotent: true })
    const submit = async (populated: any, gas: TransactionGasDetails, type4: boolean, quote: Record<string, any>) => {
      const tx = populated.transaction
      const data = { txidVersion: VERSION, to: tx.to, data: tx.data, broadcasterViewingKey: sdk.publicViewingKey,
        chainType: 0, chainID: CHAIN_ID, feesID: quote.feesID, useRelayAdapt: type4, minVersion: '8.0.0', maxVersion: '8.999.0',
        transactType: type4 ? 'TX7702' : 'COMMON', preTransactionPOIsPerTxidLeafPerList: populated.preTransactionPOIsPerTxidLeafPerList,
        ...(type4 ? { authorization: tx.authorizationList?.[0], gasLimit: calculateGasLimit(gas.gasEstimate).toString(),
          maxFeePerGas: (gas as any).maxFeePerGas.toString(), maxPriorityFeePerGas: (gas as any).maxPriorityFeePerGas.toString() }
          : { minGasPrice: (gas as any).gasPrice.toString() }) }
      const maximumCharge = ((calculateMaximumGas(gas) + BigInt(quote.collectionAllowance)) * BigInt(quote.rate) + 10n ** 18n - 1n) / 10n ** 18n
      const payload = { kind: 'execute', sequence: quote.nextSequence, request: data, maximumCharge: maximumCharge.toString(), collectionAllowance: quote.collectionAllowance }
      // Synthetic proved calldata only; never a spending key. Keep failed-before-signing
      // SDK compatibility cases reviewable after the disposable database is removed.
      appendFileSync(join(input.root, 'proved-requests.jsonl'), json({ type4, transaction: tx, gas, payload }) + '\n', { mode: 0o600 })
      const response = await request(payload)
      assert.match(response.txHash, /^0x[0-9a-f]{64}$/i)
      await service.reconcile()
      const count = signatures, replay = await request(payload)
      assert.equal(replay.txHash, response.txHash); assert.equal(signatures, count)
      assert.equal(replay.state, 'settled')
      return { hash: response.txHash, charged: replay.charged, maximumCharge: maximumCharge.toString(), quote }
    }
    log('real-fee-free-swap-proof')
    const account = await accounts.getCurrentAccount(CHAIN)
    const route = await quoteSwap(provider, WRAPPED_SYMBOL, '0.001', account.address, 'USDC')
    const swapQuote = await request({ kind: 'quote' })
    const unshields = [{ tokenAddress: TOKENS[0].address, amount: route.amount }]
    const reshields = [...new Set([route.sell, route.buy, ...(route.route?.tokens ?? [])])].map((symbol) => ({
      tokenAddress: TOKENS.find((token) => token.symbol === symbol)!.address, recipientAddress: user.railgunAddress }))
    const type4Gas: TransactionGasDetailsType4 = { evmGasType: EVMGasType.Type4, gasEstimate: 3_000_000n,
      maxFeePerGas: bnb ? 50_000_000n : 100_000n, maxPriorityFeePerGas: bnb ? 49_999_999n : 1n }
    let gas = { ...type4Gas }
    const estimated = await gasEstimateForUnprovenCrossContractCalls7702(VERSION, NETWORK_NAME, user.id, userKey,
      unshields, [], reshields, [], route.calls, gas, undefined, true, 3_000_000n)
    gas = { ...gas, gasEstimate: estimated.gasEstimate } as typeof gas
    await generateCrossContractCallsProof7702(VERSION, NETWORK_NAME, user.id, userKey, unshields, [], reshields, [], route.calls,
      undefined, true, 0n, 3_000_000n, progress)
    results.proofsCompleted = Number(results.proofsCompleted) + 1
    const swap = await populateProvedCrossContractCalls(VERSION, NETWORK_NAME, user.id, unshields, [], reshields, [], route.calls,
      undefined, true, 0n, gas)
    const swapped = await submit(swap, gas, true, swapQuote)
    await ratchetEphemeralAddress(user.id, NETWORK_NAME); await refresh(user.id, sdk.walletId)
    const privateOutput = await userBalance(usdc.address)
    assert(privateOutput >= route.minimum - route.minimum * route.shieldFee / 10_000n)
    operations.push({ kind: 'fee-free-swap', privateOutput: privateOutput.toString(), ...swapped })
    log('real-fee-free-withdrawal-proof')
    const recipient = Wallet.createRandom().address, token = new Contract(usdc.address, ['function balanceOf(address) view returns(uint256)'], provider)
    const before = BigInt(await token.balanceOf(recipient)), withdrawQuote = await request({ kind: 'quote' })
    const amounts = [{ tokenAddress: usdc.address, amount: privateOutput, recipientAddress: recipient }]
    const commonType = getEVMGasTypeForTransaction(NETWORK_NAME, false)
    assert(commonType === EVMGasType.Type0 || commonType === EVMGasType.Type1)
    const commonGas = { evmGasType: commonType, gasEstimate: 3_000_000n, gasPrice: bnb ? 50_000_000n : 100_000n }
    // Fee-free SDK population requires its self-signed gas shape, even when
    // Ophis will sign the final COMMON envelope using the original gas price.
    const sdkCommonGas = (estimate: bigint, gasPrice = commonGas.gasPrice): TransactionGasDetails => bnb
      ? { evmGasType: EVMGasType.Type0, gasEstimate: estimate, gasPrice }
      : { evmGasType: EVMGasType.Type2, gasEstimate: estimate,
        maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
    let withdrawn: Awaited<ReturnType<typeof submit>>, minimum: bigint | undefined
    if (bnb) {
      // Match the production prepaid bound-withdrawal shape: one principal proof,
      // then re-sign the SDK action with requireSuccess=true before disclosure.
      const withdrawalAccount = await accounts.getCurrentAccount(CHAIN)
      assert.notEqual(withdrawalAccount.address, account.address, 'The completed swap account must have ratcheted.')
      const feeBps: bigint = await new Contract(NETWORK.proxyContract, PROXY, provider).unshieldFee()
      minimum = unshieldAmount(privateOutput, feeBps)
      const calls = [{ to: withdrawalAccount.address, value: 0n, data: ADAPT.encodeFunctionData('transfer', [[{
        token: { tokenType: 0, tokenAddress: usdc.address, tokenSubID: 0 }, to: recipient, value: minimum,
      }]]) }]
      const principal = [{ tokenAddress: usdc.address, amount: privateOutput }]
      const estimate = await gasEstimateForUnprovenCrossContractCalls7702(VERSION, NETWORK_NAME, user.id, userKey,
        principal, [], [], [], calls, type4Gas, undefined, true, 3_000_000n)
      const withdrawalGas = { ...type4Gas, gasEstimate: estimate.gasEstimate }
      const request = await generateCrossContractCallsProof7702(VERSION, NETWORK_NAME, user.id, userKey,
        principal, [], [], [], calls, undefined, true, 0n, 3_000_000n, progress)
      results.proofsCompleted = Number(results.proofsCompleted) + 1
      assert.equal(getAddress(request.ephemeralAddress), getAddress(withdrawalAccount.address))
      const actionData = { ...request.actionData, requireSuccess: true }
      const signed = await fullWalletForID(user.id).sign7702Request(userKey, NETWORK.relayAdapt7702Contract, CHAIN,
        request.transactions, actionData, Number(request.authorization.nonce), request, undefined, request.ephemeralAddress)
      const strict = { ...request, actionData, authorization: signed.authorization, executionSignature: signed.signature }
      const encoded = encodeRequest(strict)
      const transaction = { to: withdrawalAccount.address, data: String(encoded.data), value: 0n, type: 4,
        authorizationList: [strict.authorization], chainId: CHAIN, gasLimit: calculateGasLimit(withdrawalGas.gasEstimate),
        maxFeePerGas: withdrawalGas.maxFeePerGas, maxPriorityFeePerGas: withdrawalGas.maxPriorityFeePerGas }
      assertSameExecution({ provider } as WalletSession, strict, transaction)
      const checked = assertBoundWithdrawal(transaction.data, withdrawalAccount.address, 'USDC', recipient, minimum, undefined, 'prepaid')
      assert.equal(checked.transactions.length, 1)
      assert.equal(await new Contract(NETWORK.proxyContract, PROXY, provider).unshieldFee(), feeBps)
      withdrawn = await submit({ transaction, preTransactionPOIsPerTxidLeafPerList: {} }, withdrawalGas, true, withdrawQuote)
      await ratchetEphemeralAddress(user.id, NETWORK_NAME)
    } else {
      const estimate = await gasEstimateForUnprovenUnshield(VERSION, NETWORK_NAME, user.id, userKey, amounts, [], commonGas, undefined, true)
      const withdrawalGas = { ...commonGas, gasEstimate: estimate.gasEstimate }
      await generateUnshieldProof(VERSION, NETWORK_NAME, user.id, userKey, amounts, [], undefined, true, commonGas.gasPrice, progress)
      results.proofsCompleted = Number(results.proofsCompleted) + 1
      const withdrawal = await populateProvedUnshield(VERSION, NETWORK_NAME, user.id, amounts, [], undefined, true,
        commonGas.gasPrice, sdkCommonGas(withdrawalGas.gasEstimate))
      withdrawn = await submit(withdrawal, withdrawalGas, false, withdrawQuote)
    }
    const received = BigInt(await token.balanceOf(recipient)) - before
    assert(received > 0n && received <= privateOutput)
    if (minimum !== undefined) assert.equal(received, minimum, 'The bound USDC transfer must pay the exact reviewed net amount.')
    operations.push({ kind: 'fee-free-withdrawal', shape: bnb ? 'strict-bound-one-principal-proof' : 'common',
      recipient, received: received.toString(), tokenDecimals: usdc.decimals, ...withdrawn })
    log('real-proof-included-failure-tests')
    await refresh(user.id, sdk.walletId)
    const ledger = CreditLedger.load(store), principalBeforeFailures = await userBalance()
    const failureAmounts = [{ tokenAddress: TOKENS[0].address, amount: 100_000_000_000_000n, recipientAddress: recipient }]
    const failureEstimate = await gasEstimateForUnprovenUnshield(VERSION, NETWORK_NAME, user.id, userKey,
      failureAmounts, [], commonGas, undefined, true)
    const failureGas = { ...commonGas, gasEstimate: failureEstimate.gasEstimate }
    await generateUnshieldProof(VERSION, NETWORK_NAME, user.id, userKey, failureAmounts, [], undefined, true, commonGas.gasPrice, progress)
    results.proofsCompleted = Number(results.proofsCompleted) + 1
    const failureProof = await populateProvedUnshield(VERSION, NETWORK_NAME, user.id, failureAmounts, [], undefined, true,
      commonGas.gasPrice, sdkCommonGas(failureGas.gasEstimate))
    for (const failure of ['revert', 'out-of-gas'] as const) {
      const quote = await request({ kind: 'quote' }), creditBefore = ledger.balance(claimant.address)
      const nativeBefore = await provider.getBalance(operator.address)
      inclusionFailure = failure
      const submitted = await submit(failureProof, failureGas, false, quote)
      const receipt = await finalizedCreditReceipt(provider, submitted.hash)
      assert.equal(receipt.status, 0)
      const cost = receipt.gasUsed * receipt.gasPrice
      const charged = creditCharge(cost, BigInt(quote.rate), BigInt(quote.collectionAllowance))
      const after = ledger.balance(claimant.address)
      assert.equal(BigInt(submitted.charged), charged)
      assert(charged > cost && charged <= BigInt(submitted.maximumCharge))
      assert.equal(nativeBefore - await provider.getBalance(operator.address), cost)
      assert.equal(after.charged - creditBefore.charged, charged)
      assert.equal(creditBefore.available - after.available, charged)
      assert.equal(after.reserved, 0n)
      await refresh(user.id, sdk.walletId)
      assert.equal(await userBalance(), principalBeforeFailures)
      const fundedBacking = creditBackingEvidence(await sdk.accountedCreditBacking(provider, ledger.accountedNotes(), 1))
      assert(fundedBacking.available >= ledger.requiredBacking() && fundedBacking.bounded >= ledger.earned())
      operations.push({ kind: `included-${failure}`, hash: submitted.hash, gasUsed: receipt.gasUsed.toString(),
        gasCost: cost.toString(), charged: charged.toString(), maximumCharge: submitted.maximumCharge,
        realProofValidatedBeforeInjection: true, principalUnspent: true, remainingCreditBacked: true })
    }
    log('real-memo-less-owner-refund')
    await refresh(user.id, sdk.walletId, feeFullId)
    const ownerNativeBefore = await provider.getBalance(await publicGas.getAddress())
    // Claim replay plus four execution quotes consume the real six-refresh allowance.
    // Pace this accelerated fault-test batch; do not bypass the production limiter.
    const queryWindowRemaining = Math.max(0, 60_100 - (performance.now() - firstClaimCompletedAt))
    if (queryWindowRemaining) await stage('owner-refund-query-window', () => new Promise<void>(resolve => setTimeout(resolve, queryWindowRemaining)))
    const refundQuote = await request({ kind: 'quote' })
    const gross = ledger.balance(claimant.address).available / 2n
    const refundFee = (BigInt(refundQuote.collectionAllowance) * BigInt(refundQuote.rate) + 10n ** 18n - 1n) / 10n ** 18n
    const net = gross - refundFee
    assert(net > 0n, 'Synthetic refundable balance must exceed the separately quoted refund fee.')
    const refund = await request({ kind: 'refund', sequence: refundQuote.nextSequence, gross: gross.toString(), net: net.toString(), recipient: user.railgunAddress,
      feesID: refundQuote.feesID, collectionAllowance: refundQuote.collectionAllowance })
    assert.equal(refund.state, 'awaiting-owner-transfer')
    const refundIntent = ledger.prepareOwnerOperation({ kind: 'refund', refundKey: refund.key, maximumPrivateFee: 0n,
      minimumNative: 0n, inputLimit: 1, outputLimit: 3, proofLimit: 1, marginBps: config.marginBps },
    await sdk.accountedCreditBacking(provider, ledger.accountedNotes(), 1))
    assert.equal(ledger.pendingOwnerIntent()?.key, refundIntent.key)
    const refundRecipients = [{ tokenAddress: TOKENS[0].address, amount: net, recipientAddress: user.railgunAddress }]
    const refundEstimate = await gasEstimateForUnprovenTransfer(VERSION, NETWORK_NAME, feeFullId, feeFullKey, undefined,
      refundRecipients, [], sdkCommonGas(3_000_000n, config.maxGasPrice), undefined, true)
    await generateTransferProof(VERSION, NETWORK_NAME, feeFullId, feeFullKey, false, undefined, refundRecipients, [], undefined, true, 0n, progress)
    results.proofsCompleted = Number(results.proofsCompleted) + 1
    const refundProof = await populateProvedTransfer(VERSION, NETWORK_NAME, feeFullId, false, undefined, refundRecipients, [], undefined, true, 0n,
      sdkCommonGas(refundEstimate.gasEstimate, config.maxGasPrice))
    assert(BigInt(refundProof.transaction.gasLimit!) * config.maxGasPrice <= config.maxTransactionCost)
    // Owner execution has no EIP-1559 requirement. Use the exact capped legacy price
    // so the owned simulator's receipt and sender balance measure the same expense.
    const refundNativeBefore = await provider.getBalance(await publicGas.getAddress())
    const refundTx = await publicGas.sendTransaction({ ...refundProof.transaction, type: 0, gasPrice: config.maxGasPrice,
      maxFeePerGas: undefined, maxPriorityFeePerGas: undefined })
    const refundReceipt = await finalized(refundTx.hash)
    assert.equal(refundNativeBefore - await provider.getBalance(await publicGas.getAddress()),
      refundReceipt.gasUsed * refundReceipt.gasPrice, 'Owner refund receipt must match the actual native expense.')
    await refresh(user.id, sdk.walletId, feeFullId)
    // No unassigned memo-less transfer may settle a refund merely because its amount matches.
    await service.reconcile()
    assert.equal(ledger.refund(refund.key)!.transaction_hash, null)
    ledger.recordRefundPayout(refund.key, await finalizedCreditReceipt(provider, refundTx.hash))
    await service.reconcile()
    assert.equal(ledger.refund(refund.key)!.transaction_hash, refundTx.hash)
    assert.equal(ledger.refundPayouts(refund.key).length, 1)
    const refundStatus = await request({ kind: 'refund-status', key: refund.key })
    assert.equal(refundStatus.state, 'refunded')
    assert.equal(ledger.pendingOwnerIntent(), undefined, 'Exact owner debit reconciliation must release the refund hold.')
    operations.push({ kind: 'memo-less-owner-refund', hash: refundTx.hash, key: refund.key, gross: gross.toString(), net: net.toString(),
      exactOwnerAssociationRequired: true, realOutgoingNoteVerified: true, gasUsed: refundReceipt.gasUsed.toString(),
      gasCost: (refundReceipt.gasUsed * refundReceipt.gasPrice).toString(), estimate: refundEstimate.gasEstimate.toString() })
    log('real-owner-collection-proof')
    await refresh(user.id, sdk.walletId, feeFullId)
    const beforeCredit = ledger.balance(claimant.address)
    assert.equal(beforeCredit.reserved, 0n); assert(beforeCredit.charged > 0n)
    const accounting = accountingReport(store.db)
    const earned = BigInt(accounting.receivedFees[TOKENS[0].address])
    assert.equal(earned, beforeCredit.charged + gross - net)
    const executionGasCost = BigInt(accounting.recordedGasExpenseWei)
    assert.equal(operatorNativeBefore - await provider.getBalance(operator.address), executionGasCost)
    assert.equal(ledger.earned(), earned)
    const collectionPrivateFee = BigInt(refundQuote.collectionAllowance)
    assert.equal(collectionPrivateFee, config.maxGasPrice * config.creditCollectionGas!)
    const grossCollection = earned - collectionPrivateFee
    assert(grossCollection > 0n)
    const minimumNative = executionGasCost + ((executionGasCost + collectionPrivateFee) * config.marginBps + 9_999n) / 10_000n
    const collectionIntent = ledger.prepareOwnerOperation({ kind: 'collection', maximumPrivateFee: collectionPrivateFee, minimumNative,
      inputLimit: 1, outputLimit: 3, proofLimit: 1, marginBps: config.marginBps,
      collectionFees: { unshieldFeeBps: BigInt(await new Contract(NETWORK.proxyContract, PROXY, provider).unshieldFee()),
        gatewayFeeBps: await readAnonCollectionBaseFee(provider) } },
    await sdk.accountedCreditBacking(provider, ledger.accountedNotes(), 1))
    assert.equal(ledger.pendingOwnerIntent()?.key, collectionIntent.key)
    const nativeBeforeCollection = await provider.getBalance(operator.address)
    const privateFeeRecipientBefore = await userBalance()
    // ANON 0.12.4 module21211 binds its unshield with on-chain getAdaptParams(dummy,data),
    // then generates the real proof with that exact adaptID. No pool/gateway code is replaced.
    const collectionBatch = new TransactionBatch(NETWORK.chain, config.maxGasPrice)
    const collectionWallet = fullWalletForID(feeFullId)
    collectionBatch.addOutput(TransactNote.createTransfer(RailgunEngine.decodeAddress(user.railgunAddress), collectionWallet.addressKeys,
      collectionPrivateFee, getTokenDataERC20(TOKENS[0].address), false, OutputType.BroadcasterFee, undefined))
    collectionBatch.addUnshieldData({ toAddress: ANON_COLLECTION_GATEWAY, value: grossCollection,
      tokenData: getTokenDataERC20(TOKENS[0].address), allowOverride: false })
    collectionBatch.setAdaptID({ contract: ANON_COLLECTION_GATEWAY, parameters: ZeroHash })
    const dummyCollection = await stage('collection-dummy', () => collectionBatch.generateDummyTransactions(getProver(), collectionWallet, VERSION, feeFullKey))
    const gatewayData = { recipient: operator.address, integratorFeeBP: 0, integratorFeeRecipient: ZeroAddress,
      unwrapNative: true, unwrapERC1155: false, erc1155RecipientData: '0x' }
    const gateway = new Contract(ANON_COLLECTION_GATEWAY, [
      `function getAdaptParams(${ANON_COLLECTION_ABI.getFunction('unshield')!.inputs[0].format('full')}, ${ANON_COLLECTION_ABI.getFunction('unshield')!.inputs[1].format('full')}) view returns (bytes32)`,
    ], provider)
    const adaptParameters = await stage('collection-adapt-parameters', () => gateway.getAdaptParams(dummyCollection, gatewayData), 20_000)
    collectionBatch.setAdaptID({ contract: ANON_COLLECTION_GATEWAY, parameters: adaptParameters })
    const { provedTransactions: collectionTransactions } = await stage('collection-real-proof', () => collectionBatch.generateTransactions(getProver(), collectionWallet,
      VERSION, feeFullKey, progress, false), 180_000)
    results.proofsCompleted = Number(results.proofsCompleted) + 1
    assert.equal(await gateway.getAdaptParams(collectionTransactions, gatewayData), adaptParameters)
    const nullifiers = collectionTransactions.flatMap(tx => tx.nullifiers)
    assert.equal(nullifiers.length, 1, 'The initial qualified collection consumes one real accounted note.')
    assert.equal(collectionTransactions.length, 1)
    assert.equal(collectionTransactions[0].commitments.length, 3, 'Qualify fee, change and unshield outputs together.')
    const collectionCall = { to: ANON_COLLECTION_GATEWAY, value: 0n, type: 0, gasPrice: config.maxGasPrice,
      data: ANON_COLLECTION_ABI.encodeFunctionData('unshield', [collectionTransactions, gatewayData]) }
    const collectionFrom = await publicGas.getAddress()
    const collectionEstimate = await stage('collection-gas-estimate', () => provider.estimateGas({ ...collectionCall, from: collectionFrom }))
    const collectionGasLimit = calculateGasLimit(collectionEstimate)
    assert(collectionGasLimit * config.maxGasPrice <= config.maxTransactionCost)
    const collectionTx = await publicGas.sendTransaction({ ...collectionCall, gasLimit: collectionGasLimit })
    const receipt = await finalized(collectionTx.hash)
    assert(receipt.gasUsed <= config.creditCollectionGas!)
    const externalRelayerGasCost = receipt.gasUsed * receipt.gasPrice
    const externalRelayerMinimumFee = (externalRelayerGasCost * (10_000n + config.marginBps) + 9_999n) / 10_000n
    assert(collectionPrivateFee >= externalRelayerMinimumFee, 'The measured private relay fee must cover its actual native gas and margin.')
    await refresh(sdk.walletId, user.id)
    assert.equal(await userBalance() - privateFeeRecipientBefore, collectionPrivateFee)
    // Retain only this disposable fork's public receipt/trace and numeric expectations.
    const nativeTrace = await provider.send('debug_traceTransaction', [collectionTx.hash,
      { tracer: 'callTracer', timeout: '10s', tracerConfig: { onlyTopCall: false, withLog: false } }])
    const nativeTraceJson = json({ transactionHash: collectionTx.hash, operator: operator.address,
      minimumNative: collectionIntent.minimum_native, expectedGross: grossCollection.toString(),
      actualNativeIncrease: (await provider.getBalance(operator.address) - nativeBeforeCollection).toString(), trace: nativeTrace })
    assert(Buffer.byteLength(nativeTraceJson) < 2 * 1024 ** 2, 'Synthetic owner trace exceeds its evidence bound.')
    writeFileSync(join(input.root, 'native-collection-trace.json'), nativeTraceJson, { mode: 0o600 })
    ledger.recordOwnerPayout(collectionIntent.key, await finalizedCreditReceipt(provider, collectionTx.hash))
    const verifiedCollection = await sdk.confirmedOwnerCollection(provider, ledger.scope, collectionIntent,
      ledger.accountedNotes(), ledger.ownerPayouts(collectionIntent.key)[0])
    ledger.settleOwnerCollection(collectionIntent.key, verifiedCollection)
    assert.equal(ledger.earned(), 0n); assert.equal(ledger.pendingOwnerIntent(), undefined)
    const collectedNet = await provider.getBalance(operator.address) - nativeBeforeCollection
    const backing = creditBackingEvidence(await sdk.accountedCreditBacking(provider, ledger.accountedNotes(), 1))
    assert(backing.available >= ledger.requiredBacking())
    operations.push({ kind: 'owner-collection', hash: collectionTx.hash, intentKey: collectionIntent.key, debit: earned.toString(),
      gross: grossCollection.toString(), privateFee: collectionPrivateFee.toString(), privateFeeReceiptVerified: true,
      externalRelayerGasCost: externalRelayerGasCost.toString(), externalRelayerMinimumFee: externalRelayerMinimumFee.toString(),
      privateFeeCoversExternalGasAndMargin: true,
      net: collectedNet.toString(), gasUsed: receipt.gasUsed.toString(), estimate: collectionEstimate.toString(),
      nullifiers: nullifiers.length, outputs: 3, proofs: 1, feeWalletViewOnlyForBackend: true, remainingCreditBacked: true,
      pinnedAnonGateway: ANON_COLLECTION_GATEWAY, realAdaptBinding: true, canonicalNativeTraceVerified: true, ownerJournalSettled: true })
    const ownerGasCost = [refundReceipt, receipt]
      .reduce((total, item) => total + item.gasUsed * item.gasPrice, 0n)
    const totalGasCost = executionGasCost + ownerGasCost
    const minimumNet = totalGasCost + ((totalGasCost + collectionPrivateFee) * config.marginBps + 9_999n) / 10_000n
    assert(collectedNet >= minimumNet, 'Native recovery must cover every recorded expense plus the configured margin.')
    const ownerProfit = await provider.getBalance(await publicGas.getAddress()) - ownerNativeBefore +
      await provider.getBalance(operator.address) - operatorNativeBefore
    assert.equal(ownerProfit, collectedNet - totalGasCost)
    operations.push({ kind: 'owner-native-recovery', collectionHash: collectionTx.hash,
      refundedOperatorGas: executionGasCost.toString(), ownerGasCost: ownerGasCost.toString(), totalGasCost: totalGasCost.toString(),
      ownerPrivateFee: collectionPrivateFee.toString(),
      collectedNet: collectedNet.toString(), minimumNetWithMargin: minimumNet.toString(), nativeProfit: ownerProfit.toString(),
      marginBps: config.marginBps.toString(), remainingCreditBacked: true, excludesUserBootstrapAndGuardCommissioning: true,
      measuredCollectionInputs: 1, universalFragmentationBound: false })
    results.signatures = signatures; results.submissions = submissions
    results.balance = JSON.parse(json(ledger.balance(claimant.address))); results.protectedTransport = transport.stats()
    results.artifactBytes = artifactBytes
    assert.equal(signatures, 4); assert.equal(submissions, 4); assert.equal(store.hasPending(), false)
    assert.equal(transport.stats().leakedWrite, false)
    assert.equal(transport.stats().protectedWrites, 4)
    if (bnb) assert.equal(transport.stats().bundles.length, 4)
    results.passed = true
    return results
  } finally {
    writeFileSync(join(input.root, 'result.json'), json(results), { mode: 0o600 })
    if (loaded) await unloadProvider(NETWORK_NAME).catch(() => {})
    await sdk.stop().catch(() => {}); await transport?.close().catch(() => {})
    provider.destroy(); store.close()
    const free = statfsSync(input.root); log('cleanup', { freeBytes: free.bavail * free.bsize })
  }
}
