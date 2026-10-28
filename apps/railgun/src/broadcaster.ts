import { CHAIN, CHAIN_NAME, CHAIN_ID, CONFIG, ENVIRONMENT, FEE_SIGNER, VERSION } from './config'
import { BroadcasterTransaction, WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web'
import {
  calculateGasLimit,
  calculateGasPrice,
  EVMGasType,
  POI_REQUIRED_LISTS,
  type SelectedBroadcaster,
  type TransactionGasDetailsType4,
  type TransactionGasDetailsType1,
  type RailgunPopulateTransactionResponse,
} from '@railgun-community/shared-models'
import { calculateBroadcasterFeeERC20Amount, validateRailgunAddress } from '@railgun-community/wallet'
import { getAddress, isAddress, type TransactionRequest } from 'ethers'
import type { WalletSession } from './wallet'

let starting: Promise<void> | undefined
let reportConnection: (status: string) => void = () => {}
const DISCOVERY_TIMEOUT_MS = 45_000

export async function startBroadcasters(onStatus: (status: string) => void): Promise<void> {
  if (ENVIRONMENT !== 'ethereum')
    throw new Error(
      'Mainnet broadcasters are disabled in this local fork build. Use the fork test harness for private execution.',
    )
  const signer = FEE_SIGNER
  if (!signer || !validateRailgunAddress(signer))
    throw new Error('Configure a verified Railgun broadcaster fee signer before enabling private submissions.')
  reportConnection = onStatus
  if (!WakuBroadcasterClient.isStarted()) {
    onStatus('Connecting to the private broadcaster network…')
    starting ??= WakuBroadcasterClient.start(
      CONFIG.chain,
      {
        trustedFeeSigner: signer,
        poiActiveListKeys: POI_REQUIRED_LISTS.map((list) => list.key),
        enableHealthcheckLogs: false,
      },
      (_chain, status) => reportConnection(`Broadcaster: ${status}`),
    ).finally(() => { starting = undefined })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        starting,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Broadcaster connection timed out. Check your connection and try again.')), DISCOVERY_TIMEOUT_MS)
        }),
      ])
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'Broadcaster connection failed.')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

export async function selectBroadcaster(
  tokenAddress: string,
  use7702: boolean,
  onStatus: (status: string) => void,
): Promise<SelectedBroadcaster> {
  await startBroadcasters(onStatus)
  onStatus('Waiting for a fresh compatible broadcaster fee…')
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  while (true) {
    const choices: SelectedBroadcaster[] = WakuBroadcasterClient.findBroadcastersForToken(CONFIG.chain, tokenAddress, use7702, use7702) || []
    const selected = choices
      .filter(
        (candidate) =>
          candidate.tokenFee.expiration > Date.now() + 60_000 && (!use7702 || supportsCanonicalDelegate(candidate)),
      )
      .sort((a, b) => (BigInt(a.tokenFee.feePerUnitGas) < BigInt(b.tokenFee.feePerUnitGas) ? -1 : 1))[0]
    if (selected) {
      validateBroadcaster(selected, tokenAddress, use7702)
      onStatus('A fresh compatible broadcaster fee is ready.')
      return selected
    }
    if (Date.now() >= deadline) {
      const message = 'No verified compatible broadcaster fee arrived. Keep this page open and try again.'
      onStatus(message)
      throw new Error(message)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000))
  }
}

export function validateBroadcaster(selected: SelectedBroadcaster, tokenAddress: string, use7702: boolean): void {
  if (
    getAddress(selected.tokenAddress) !== getAddress(tokenAddress) ||
    !validateRailgunAddress(selected.railgunAddress) ||
    BigInt(selected.tokenFee.feePerUnitGas) <= 0n
  )
    throw new Error('Invalid broadcaster quote.')
  if (use7702 && !supportsCanonicalDelegate(selected))
    throw new Error('Broadcaster does not support the canonical Railgun delegate.')
}

export async function gasDetails(session: WalletSession): Promise<TransactionGasDetailsType4> {
  const fee = await session.provider.getFeeData()
  // BSC supports type-4 authorizations but its RPC reports legacy transaction pricing.
  const legacy = CHAIN_ID === 56 && fee.maxFeePerGas == null && fee.gasPrice != null && fee.gasPrice > 0n
  const maxFeePerGas = legacy ? fee.gasPrice : fee.maxFeePerGas
  const maxPriorityFeePerGas = legacy ? fee.gasPrice : fee.maxPriorityFeePerGas
  if (maxFeePerGas == null || maxPriorityFeePerGas == null || maxFeePerGas <= 0n || maxPriorityFeePerGas < 0n || maxPriorityFeePerGas > maxFeePerGas)
    throw new Error(`${CHAIN_NAME} fee estimate unavailable.`)
  return {
    evmGasType: EVMGasType.Type4,
    gasEstimate: 3_000_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }
}

export async function minimumGasPrice(session: WalletSession, gas: TransactionGasDetailsType4): Promise<bigint> {
  if (CHAIN_ID === 56) {
    const fee = await session.provider.getFeeData()
    if (fee.maxFeePerGas == null) {
      if (fee.gasPrice == null || fee.gasPrice <= 0n) throw new Error('BNB Chain gas price unavailable.')
      return fee.gasPrice
    }
  }
  const block = await session.provider.getBlock('latest')
  if (block?.baseFeePerGas == null) throw new Error(`${CHAIN_NAME} base fee unavailable.`)
  return block.baseFeePerGas + gas.maxPriorityFeePerGas
}

export function capGasPrice(gas: TransactionGasDetailsType4, selected: SelectedBroadcaster, budget: bigint): TransactionGasDetailsType4 {
  const rate = BigInt(selected.tokenFee.feePerUnitGas)
  if (budget <= 0n || rate <= 0n || gas.gasEstimate <= 0n) throw new Error('Invalid broadcaster fee budget.')
  // Match the SDK's downward fee rounding at the last affordable gas price.
  const cap = ((budget + 1n) * 10n ** 18n - 1n) / (rate * calculateGasLimit(gas.gasEstimate))
  const maxFeePerGas = cap < gas.maxFeePerGas ? cap : gas.maxFeePerGas
  return { ...gas, maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : gas.maxPriorityFeePerGas }
}

export function broadcasterFee(
  selected: SelectedBroadcaster,
  gas: TransactionGasDetailsType4 | TransactionGasDetailsType1,
) {
  if (selected.tokenFee.expiration <= Date.now() + 60_000)
    throw new Error('Broadcaster fee expired. Prepare another transaction.')
  return {
    ...calculateBroadcasterFeeERC20Amount(
      { tokenAddress: selected.tokenAddress, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) },
      gas,
    ),
    recipientAddress: selected.railgunAddress,
  }
}

export async function assertSubmittable(
  session: WalletSession,
  selected: SelectedBroadcaster,
  gas: TransactionGasDetailsType4 | TransactionGasDetailsType1,
): Promise<void> {
  if (ENVIRONMENT !== 'ethereum') throw new Error('Mainnet broadcasting is disabled in this local fork build.')
  // Detect known local forks even if the operator selected the wrong environment.
  const fork = await session.provider.send('anvil_metadata', []).catch(() => undefined)
  const hardhat = await session.provider.send('hardhat_metadata', []).catch(() => undefined)
  if (fork || hardhat) throw new Error('Broadcaster submission is disabled on local forks.')
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
  broadcasterFee(selected, gas)
  if (gas.evmGasType === EVMGasType.Type4 && gas.maxFeePerGas < await minimumGasPrice(session, gas))
    throw new Error(`${CHAIN_NAME} gas price exceeds this quote’s cap. Check recovery before requesting a fresh quote.`)
}

export async function submitPrivate(
  session: WalletSession,
  populated: RailgunPopulateTransactionResponse,
  selected: SelectedBroadcaster,
  gas: TransactionGasDetailsType4 | TransactionGasDetailsType1,
  use7702: boolean,
): Promise<string> {
  await assertSubmittable(session, selected, gas)
  if (!populated.nullifiers?.length) throw new Error('Private transaction has no spend nullifiers.')
  const transaction = populated.transaction as TransactionRequest
  if (!transaction.to || typeof transaction.to !== 'string' || typeof transaction.data !== 'string')
    throw new Error('Invalid populated private transaction.')
  const authorization = use7702 ? transaction.authorizationList?.[0] : undefined
  if (use7702 && !authorization) throw new Error('Missing 7702 authorization.')
  const type4 =
    gas.evmGasType === EVMGasType.Type4
      ? {
          gasLimit: calculateGasLimit(gas.gasEstimate),
          maxFeePerGas: gas.maxFeePerGas,
          maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        }
      : undefined
  if (use7702 && !type4) throw new Error('Type-4 fees required for a private swap.')
  const broadcast = await BroadcasterTransaction.create(
    VERSION,
    transaction.to,
    transaction.data,
    selected.railgunAddress,
    selected.tokenFee.feesID,
    CONFIG.chain,
    populated.nullifiers,
    use7702 ? 0n : calculateGasPrice(gas),
    use7702,
    populated.preTransactionPOIsPerTxidLeafPerList,
    authorization,
    type4,
  )
  return broadcast.send()
}

export interface PrivateSubmitter {
  assertReady: typeof assertSubmittable
  send: typeof submitPrivate
}
export const privateSubmitter: PrivateSubmitter = { assertReady: assertSubmittable, send: submitPrivate }

function supportsCanonicalDelegate(selected: SelectedBroadcaster): boolean {
  const delegate = selected.tokenFee.relayAdapt7702
  return !!delegate && isAddress(delegate) && getAddress(delegate) === getAddress(CONFIG.relayAdapt7702Contract)
}
