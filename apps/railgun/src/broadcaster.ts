import { CHAIN, CHAIN_NAME, CHAIN_ID, CONFIG, ENVIRONMENT, FEE_SIGNER, NETWORK, OPHIS_BROADCASTER, PROTECTED_BROADCASTERS, VERSION } from './config'
import { assertFinalQuoteFresh, type FinalQuoteCheck } from './recipe'
import { assertAtomicWithdrawal } from './execution'
import { BroadcasterTransaction, WakuBroadcasterClient } from '@railgun-community/waku-broadcaster-client-web'
import {
  calculateGasLimit,
  calculateGasPrice,
  calculateMaximumGas,
  EVMGasType,
  getEVMGasTypeForTransaction,
  type SelectedBroadcaster,
  type TransactionGasDetailsType4,
  type TransactionGasDetailsType1,
  type TransactionGasDetailsType0,
  type RailgunPopulateTransactionResponse,
} from '@railgun-community/shared-models'
import { validateRailgunAddress } from '@railgun-community/wallet'
import { getAddress, isAddress, type TransactionRequest } from 'ethers'
import type { WalletSession } from './wallet'
import { feeAddressFor } from './fee-asset'

let starting: Promise<void> | undefined
let reportConnection: (status: string) => void = () => {}
const DISCOVERY_TIMEOUT_MS = 45_000
type BroadcasterGas = TransactionGasDetailsType4 | TransactionGasDetailsType1 | TransactionGasDetailsType0

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
        poiActiveListKeys: [],
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
  expectedBroadcaster?: string,
): Promise<SelectedBroadcaster> {
  if (CHAIN_ID === 1 && ENVIRONMENT === 'ethereum' && expectedBroadcaster && expectedBroadcaster !== FEE_SIGNER)
    throw new Error('This saved proof belongs to a retired Ethereum broadcaster. Keep it and use public-wallet recovery; do not prepare another withdrawal.')
  tokenAddress = feeAddressFor(tokenAddress)
  if (use7702 && ENVIRONMENT === 'ethereum' && !protectedBroadcasters().length)
    throw new Error('Protected execution is not available on this network. Swaps, native withdrawals and withdrawals with fees paid in another token require it. Same-token withdrawals and public-wallet recovery may still be available.')
  await startBroadcasters(onStatus)
  onStatus('Waiting for a fresh compatible broadcaster fee…')
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS
  while (true) {
    const choices: SelectedBroadcaster[] = WakuBroadcasterClient.findBroadcastersForToken(CONFIG.chain, tokenAddress, use7702, use7702) || []
    const selected = choices
      .filter(
        (candidate) =>
          candidate.tokenFee.expiration > Date.now() + 60_000 &&
          isPermittedBroadcasterIdentity(candidate.railgunAddress) &&
          (!expectedBroadcaster || candidate.railgunAddress === expectedBroadcaster) &&
          (!use7702 || (supportsCanonicalDelegate(candidate) && isProtectedBroadcaster(candidate))),
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
  if (!isPermittedBroadcasterIdentity(selected.railgunAddress))
    throw new Error(CHAIN_ID === 1 ? 'Ethereum submissions require the reviewed Ophis fee identity.'
      : 'The Ophis broadcaster is not approved for public submissions on this network. Keep any saved proof for recovery.')
  if (
    getAddress(selected.tokenAddress) !== getAddress(feeAddressFor(tokenAddress)) ||
    !validateRailgunAddress(selected.railgunAddress) ||
    BigInt(selected.tokenFee.feePerUnitGas) <= 0n
  )
    throw new Error('Invalid broadcaster quote.')
  if (use7702 && !supportsCanonicalDelegate(selected))
    throw new Error('Broadcaster does not support the canonical Railgun delegate.')
  if (use7702 && ENVIRONMENT === 'ethereum' && !isProtectedBroadcaster(selected))
    throw new Error('Broadcaster is not approved for protected swaps on this network.')
}

export async function gasDetails(session: WalletSession): Promise<TransactionGasDetailsType4> {
  const fee = await session.provider.getFeeData()
  // BNB's admission floor uses gasPrice even when its RPC also returns EIP-1559 hints.
  const legacy = CHAIN_ID === 56
  const maxFeePerGas = legacy ? fee.gasPrice : fee.maxFeePerGas
  const suggestedPriorityFee = legacy ? fee.gasPrice : fee.maxPriorityFeePerGas
  // Private operators require a positive tip even when the read node suggests zero.
  const maxPriorityFeePerGas = suggestedPriorityFee === 0n ? 1n : suggestedPriorityFee
  if (maxFeePerGas == null || maxPriorityFeePerGas == null || maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n || maxPriorityFeePerGas > maxFeePerGas)
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
    if (fee.gasPrice == null || fee.gasPrice <= 0n) throw new Error('BNB Chain gas price unavailable.')
    return fee.gasPrice
  }
  const block = await session.provider.getBlock('latest')
  if (block?.baseFeePerGas == null) throw new Error(`${CHAIN_NAME} base fee unavailable.`)
  return block.baseFeePerGas + gas.maxPriorityFeePerGas
}

export function capGasPrice(gas: TransactionGasDetailsType4, selected: SelectedBroadcaster, budget: bigint): TransactionGasDetailsType4 {
  const rate = BigInt(selected.tokenFee.feePerUnitGas)
  if (budget <= 0n || rate <= 0n || gas.gasEstimate <= 0n) throw new Error('Invalid broadcaster fee budget.')
  const cap = budget * 10n ** 18n / (rate * calculateGasLimit(gas.gasEstimate))
  const maxFeePerGas = cap < gas.maxFeePerGas ? cap : gas.maxFeePerGas
  return { ...gas, maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : gas.maxPriorityFeePerGas }
}

export function broadcasterFee(
  selected: SelectedBroadcaster,
  gas: BroadcasterGas,
) {
  if (selected.tokenFee.expiration <= Date.now() + 60_000)
    throw new Error('Broadcaster fee expired. Prepare another transaction.')
  const cost = BigInt(selected.tokenFee.feePerUnitGas) * calculateMaximumGas(gas)
  if (BigInt(selected.tokenFee.feePerUnitGas) <= 0n || cost < 0n) throw new Error('Invalid broadcaster fee budget.')
  return {
    tokenAddress: selected.tokenAddress,
    // A fraction of a token base unit must not reduce gas reimbursement or the margin.
    amount: (cost + 10n ** 18n - 1n) / 10n ** 18n,
    recipientAddress: selected.railgunAddress,
  }
}

export async function assertSubmittable(
  session: WalletSession,
  selected: SelectedBroadcaster,
  gas: BroadcasterGas,
): Promise<void> {
  if (ENVIRONMENT !== 'ethereum') throw new Error('Mainnet broadcasting is disabled in this local fork build.')
  validateBroadcaster(selected, selected.tokenAddress, gas.evmGasType === EVMGasType.Type4)
  const policy = PROTECTED_BROADCASTERS[CHAIN_ID]?.find((operator) => operator.railgunAddress === selected.railgunAddress)
  if (policy && (calculateGasPrice(gas) > policy.maxGasPrice || calculateMaximumGas(gas) > policy.maxTransactionCost))
    throw new Error('This gas quote exceeds the Ophis broadcaster limits. Wait for lower gas prices; check recovery before preparing another transaction.')
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
  gas: BroadcasterGas,
  use7702: boolean,
  checkedAt?: FinalQuoteCheck,
): Promise<string> {
  await assertSubmittable(session, selected, gas)
  if (use7702) assertFinalQuoteFresh(checkedAt)
  if (!populated.nullifiers?.length) throw new Error('Private transaction has no spend nullifiers.')
  const transaction = populated.transaction as TransactionRequest
  if (!transaction.to || typeof transaction.to !== 'string' || typeof transaction.data !== 'string')
    throw new Error('Invalid populated private transaction.')
  if (!use7702 && (gas.evmGasType === EVMGasType.Type4 ||
    gas.evmGasType !== getEVMGasTypeForTransaction(NETWORK, false) || transaction.authorizationList?.length ||
    getAddress(transaction.to) !== getAddress(CONFIG.proxyContract)))
    throw new Error('Common submissions must be withdrawals through the selected privacy contract.')
  if (!use7702) assertAtomicWithdrawal(transaction.data, CHAIN_ID === 56 ? 'WBNB' : undefined)
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
    populated.preTransactionPOIsPerTxidLeafPerList ?? {},
    authorization,
    type4,
  )
  validateBroadcaster(selected, selected.tokenAddress, use7702)
  if (use7702) {
    broadcasterFee(selected, gas)
    assertFinalQuoteFresh(checkedAt)
  }
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

function protectedBroadcasters() {
  // Approval must cover the router deadline and SDK retry window, not just the first send.
  return (PROTECTED_BROADCASTERS[CHAIN_ID] ?? []).filter((operator) => operator.expiresAt > Date.now() + 15 * 60_000)
}

function isPermittedBroadcasterIdentity(address: string): boolean {
  if (ENVIRONMENT !== 'ethereum') return true
  if (CHAIN_ID === 1) return address === FEE_SIGNER
  // A trusted fee signer establishes a price band, not an operator allowlist.
  // Keep other COMMON operators available while excluding our unapproved pilot.
  return address.toLowerCase() !== OPHIS_BROADCASTER.toLowerCase() ||
    protectedBroadcasters().some((operator) => operator.railgunAddress === address)
}

function isProtectedBroadcaster(selected: SelectedBroadcaster): boolean {
  return protectedBroadcasters().some((operator) => operator.railgunAddress === selected.railgunAddress)
}
