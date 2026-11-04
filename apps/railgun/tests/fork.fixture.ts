import {
  POI,
  POINodeInterface,
  type Chain,
  type TXIDVersion,
  type BlindedCommitmentData,
  type POIsPerList,
} from '@railgun-community/engine'
import { balanceForERC20Token, fullWalletForID, pausePPOIBatchingForChain,
  encryptDataWithSharedKey, getRailgunWalletAddressData, tryDecryptJSONDataWithSharedKey, createRailgunWallet } from '@railgun-community/wallet'
import { calculateGasLimit, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { FeeData, JsonRpcProvider, Mnemonic, randomBytes, hexlify } from 'ethers'
import { CHAIN, CHAIN_ID, CHAIN_NAME, RPC_PATH, NATIVE_SYMBOL, WRAPPED_SYMBOL, CONFIG, FEE_SIGNER, MIN_SWAP_GAS, NETWORK, TOKENS, VERSION, type TokenSymbol } from '../src/config'
import { openWallet, syncWallet, type WalletSession } from '../src/wallet'
import { executePrivateSwap, preparePrivateSwap } from '../src/private-swap'
import { amountFromInput, quoteSwap } from '../src/recipe'
import { shield } from '../src/shield'
import { recoverToken, scanRecovery } from '../src/recovery'
import { prepareUnshield, executeUnshield } from '../src/unshield'
import { pendingSwap, reconcilePendingSwap } from '../src/journal'
import { unusedSwapAccount } from '../src/account'
import { broadcasterFee, type PrivateSubmitter } from '../src/broadcaster'
import { encryptionKey, readPreference, writePreference } from '../src/storage'

// Fork shields are absent from the live PPOI service. This fixture never enters the production bundle.
class ForkPOI extends POINodeInterface {
  isActive(): boolean {
    return false
  }
  async isRequired(): Promise<boolean> {
    return false
  }
  async getPOIsPerList(
    _v: TXIDVersion,
    _chain: Chain,
    _keys: string[],
    _notes: BlindedCommitmentData[],
  ): Promise<Record<string, POIsPerList>> {
    return {}
  }
  async getPOIMerkleProofs(): Promise<never> {
    throw new Error('Live PPOI is outside this fork test.')
  }
  async validatePOIMerkleroots(): Promise<boolean> {
    return false
  }
  async submitPOI(): Promise<void> {
    throw new Error('Live PPOI is outside this fork test.')
  }
  async submitLegacyTransactProofs(): Promise<void> {
    throw new Error('Live PPOI is outside this fork test.')
  }
}

const active: { session?: WalletSession } = {}

export async function createFreshForkWallet(password: string): Promise<void> {
  const provider = new JsonRpcProvider(new URL(RPC_PATH, location.origin).href)
  try {
    if (location.hostname !== '127.0.0.1' || !(await provider.send('anvil_metadata', [])).forkedNetwork ||
      (await provider.getNetwork()).chainId !== CHAIN || await readPreference('wallet') !== undefined)
      throw new Error('Fresh fork wallet creation requires an empty isolated loopback profile.')
    const salt = randomBytes(32), key = await encryptionKey(password, salt)
    // A newly generated key has no earlier notes; the public commitment tree still synchronizes in full.
    const info = await createRailgunWallet(key, Mnemonic.fromEntropy(randomBytes(16)).phrase,
      { [NETWORK]: await provider.getBlockNumber() })
    await writePreference('wallet', { id: info.id, salt: hexlify(salt) })
  } finally { provider.destroy() }
}

export async function loadForkSession(password: string): Promise<string> {
  const provider = new JsonRpcProvider(new URL(RPC_PATH, location.origin).href)
  if (!(await provider.send('anvil_metadata', [])).forkedNetwork || (await provider.getNetwork()).chainId !== CHAIN)
    throw new Error(`A local ${CHAIN_NAME} fork is required.`)
  active.session = await openWallet(provider, password, undefined)
  pausePPOIBatchingForChain(CONFIG.chain)
  POI.init([], new ForkPOI())
  if (await pendingSwap(active.session)) await reconcilePendingSwap(active.session)
  return active.session.info.railgunAddress
}

function session(): WalletSession {
  if (!active.session) throw new Error('Load the test wallet first.')
  return active.session
}

export async function forkBalance(): Promise<string> {
  const current = session()
  await syncWallet(current)
  return String(
    await balanceForERC20Token(VERSION, fullWalletForID(current.info.id), NETWORK, TOKENS.USDC.address, true),
  )
}

export async function forkWethBalance(): Promise<string> {
  const current = session()
  await syncWallet(current)
  return String(
    await balanceForERC20Token(VERSION, fullWalletForID(current.info.id), NETWORK, TOKENS[WRAPPED_SYMBOL].address, true),
  )
}

const localSubmitter: PrivateSubmitter = {
  assertReady: async (current, selected, gas) => {
    if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork)
      throw new Error('Local submission requires Anvil.')
    broadcasterFee(selected, gas)
  },
  send: async (current, populated, _selected, gas) => {
    if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork)
      throw new Error('Local submission requires Anvil.')
    const signer = await current.provider.getSigner(0)
    const transaction = await signer.sendTransaction(populated.transaction)
    const receipt = await transaction.wait()
    if (!receipt || receipt.status !== 1) throw new Error('Fork transaction did not confirm.')
    console.info('[fork-gas]', JSON.stringify({
      hash: transaction.hash,
      sdkEstimate: gas.gasEstimate.toString(),
      transactionGasLimit: transaction.gasLimit.toString(),
      gasUsed: receipt.gasUsed.toString(),
      gasPrice: receipt.gasPrice.toString(),
    }))
    return transaction.hash
  },
}

export async function forkPrepareSwap(sell: TokenSymbol, value: string, feePerUnitGas = '1000000',
  feeAddress = FEE_SIGNER, feesID = 'local-test-only') {
  const current = session()
  const account = await unusedSwapAccount(current)
  const quote = await quoteSwap(current.provider, sell, value, account.address)
  const selected: SelectedBroadcaster = {
    railgunAddress: feeAddress,
    tokenAddress: TOKENS[sell].address,
    tokenFee: {
      feePerUnitGas,
      expiration: Date.now() + 600_000,
      feesID,
      availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract,
      relayAdapt7702: CONFIG.relayAdapt7702Contract,
      reliability: 1,
    },
  }
  const prepared = await preparePrivateSwap(current, quote, selected)
  console.info('[fork-plan]', JSON.stringify({
    sell,
    amount: value,
    configuredGasFloor: MIN_SWAP_GAS.toString(),
    sdkEstimate: prepared.gas.gasEstimate.toString(),
    feeTokenRate: selected.tokenFee.feePerUnitGas,
    maxFeePerGas: prepared.gas.maxFeePerGas.toString(),
    privateFee: prepared.fee.amount.toString(),
  }))
  return prepared
}

export async function forkOperatorSwap(options: { feeAddress: string; feesID: string; feePerUnitGas: string }) {
  const current = session()
  if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork || CHAIN_ID !== 1)
    throw new Error('The operator roundtrip test requires a local Ethereum fork.')
  const prepared = await forkPrepareSwap('WETH', '0.001', options.feePerUnitGas, options.feeAddress, options.feesID)
  const submitter: PrivateSubmitter = { assertReady: localSubmitter.assertReady,
    send: async (_session, populated, selected, gas) => {
      if (gas.evmGasType !== 4) throw new Error('Type-4 swap required.')
      const transaction = populated.transaction
      const key = getRailgunWalletAddressData(selected.railgunAddress).viewingPublicKey
      const data = {
        txidVersion: VERSION, to: transaction.to, data: transaction.data,
        broadcasterViewingKey: Buffer.from(key).toString('hex'), chainType: 0, chainID: 1,
        feesID: selected.tokenFee.feesID, useRelayAdapt: true, minVersion: '8.0.0', maxVersion: '8.999.0',
        transactType: 'TX7702', preTransactionPOIsPerTxidLeafPerList: populated.preTransactionPOIsPerTxidLeafPerList,
        authorization: transaction.authorizationList?.[0], gasLimit: calculateGasLimit(gas.gasEstimate).toString(),
        maxFeePerGas: gas.maxFeePerGas.toString(), maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString(),
      }
      const encoded = JSON.parse(JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value)) as object
      const encrypted = await encryptDataWithSharedKey(encoded, key)
      const send = (window as unknown as { ophisOperatorTest: (payload: string) => Promise<string> }).ophisOperatorTest
      const reply = await send(JSON.stringify({ method: 'transact', id: 1,
        params: { pubkey: encrypted.randomPubKey, encryptedData: encrypted.encryptedData } }))
      const result = tryDecryptJSONDataWithSharedKey(JSON.parse(reply).result, encrypted.sharedKey) as { txHash?: string; error?: string } | null
      if (!result?.txHash || result.error) throw new Error(result?.error ?? 'No encrypted operator response.')
      return result.txHash
    } }
  return executePrivateSwap(current, prepared, (message) => console.info('[fork-proof]', message), submitter)
}

export async function forkSwap(sell: TokenSymbol, value: string, feePerUnitGas = '1000000'): Promise<string> {
  const prepared = await forkPrepareSwap(sell, value, feePerUnitGas)
  return executePrivateSwap(session(), prepared, (message) => console.info('[fork-proof]', message), localSubmitter)
}

export async function forkBudgetSwap() {
  const current = session()
  if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork) throw new Error('Only an Anvil fork may model a gas price.')
  const balance = await balanceForERC20Token(VERSION, fullWalletForID(current.info.id), NETWORK, TOKENS.WETH.address, true)
  if (balance !== 1_216_490_555_332_357n) throw new Error('The fee-budget test must use the exact isolated private balance.')
  const getBlock = current.provider.getBlock
  const getFeeData = current.provider.getFeeData
  let prepared: Awaited<ReturnType<typeof forkPrepareSwap>>
  try {
    // Model a stable price for quote preparation; restore the provider before real proof execution.
    current.provider.getFeeData = async () => new FeeData(180_000_000n, 360_000_000n, 0n)
    current.provider.getBlock = async (...args) => {
      const block = await getBlock.apply(current.provider, args)
      return block ? { ...block, baseFeePerGas: 180_000_000n } as typeof block : block
    }
    prepared = await forkPrepareSwap('WETH', '0.0005', '1000000000000000000')
  } finally {
    current.provider.getBlock = getBlock
    current.provider.getFeeData = getFeeData
  }
  if (!prepared.gasCapped || prepared.quote.amount !== 500_000_000_000_000n || prepared.quote.amount + prepared.fee.amount > balance)
    throw new Error('The capped quote changed the amount or exceeded the private balance.')
  const hash = await executePrivateSwap(current, prepared, (message) => console.info('[fork-proof]', message), localSubmitter)
  return { hash, amount: prepared.quote.amount.toString(), fee: prepared.fee.amount.toString(), gasEstimate: prepared.gas.gasEstimate.toString(), maxFeePerGas: prepared.gas.maxFeePerGas.toString() }
}

export async function forkShieldETH(value: string): Promise<string> {
  const current = session()
  if (!(await current.provider.send('anvil_metadata', [])).forkedNetwork)
    throw new Error('Only an Anvil wallet may fund this test.')
  if ((await current.provider.getNetwork()).chainId !== CHAIN) throw new Error('Fork network changed.')
  const receipt = await shield(current, await current.provider.getSigner(0), NATIVE_SYMBOL, amountFromInput(value, WRAPPED_SYMBOL))
  await syncWallet(current)
  return receipt.hash
}

export async function forkWithdrawal(recipient: string): Promise<string> {
  const current = session()
  const selected: SelectedBroadcaster = {
    railgunAddress: FEE_SIGNER,
    tokenAddress: TOKENS.USDC.address,
    tokenFee: {
      feePerUnitGas: '1000000',
      expiration: Date.now() + 600_000,
      feesID: 'local-test-only',
      availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract,
      relayAdapt7702: CONFIG.relayAdapt7702Contract,
      reliability: 1,
    },
  }
  const prepared = await prepareUnshield(current, 'USDC', '1', recipient, selected)
  return executeUnshield(current, prepared, (message) => console.info('[fork-proof]', message), localSubmitter)
}

export async function forkRecovery(index: number): Promise<string> {
  return recoverToken(session(), index, 'USDC')
}

export async function forkAccount(index: number): Promise<string> {
  return (await session().accounts.getAccount(CHAIN, index)).address
}

export async function recoveryStatus(index: number): Promise<string> {
  return scanRecovery(session(), index)
}
