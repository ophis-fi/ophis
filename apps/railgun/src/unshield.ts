import { CHAIN, CHAIN_NAME, CONFIG, NETWORK, PERMIT2, PILOT_WITHDRAWAL_RECIPIENT, PROXY, ROUTER, TOKENS, VERSION, type TokenSymbol } from './config'
import { getEVMGasTypeForTransaction, EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import {
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
  fullWalletForID,
  balanceForERC20Token,
} from '@railgun-community/wallet'
import { Contract, getAddress, ZeroAddress } from 'ethers'
import { broadcasterFee, selectBroadcaster, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import { amountFromInput, unshieldAmount } from './recipe'
import { pendingSwap } from './journal'
import { assertAtomicWithdrawal } from './execution'
import {
  assertWithdrawalReceipt,
  pendingWithdrawal,
  reconcilePendingWithdrawal,
  savePendingWithdrawal,
  withdrawalInputsSpent,
} from './withdrawal-journal'
import { refreshReceivedBalances, requireWalletSync, type WalletSession } from './wallet'

export async function prepareUnshield(
  session: WalletSession,
  token: TokenSymbol,
  value: string,
  recipient: string,
  selected: SelectedBroadcaster,
  maximum = false,
) {
  requireWalletSync()
  if ((await pendingWithdrawal(session)) || (await pendingSwap(session)))
    throw new Error('Resolve the pending private transaction before preparing another withdrawal.')
  validateBroadcaster(selected, TOKENS[token].address, false)
  const destination = getAddress(recipient)
  if (PILOT_WITHDRAWAL_RECIPIENT &&
    (token !== 'USDC' || destination !== getAddress(PILOT_WITHDRAWAL_RECIPIENT)))
    throw new Error('This pilot withdraws USDC to its selected public recipient. Choose USDC before preparing a proof.')
  assertWithdrawalRecipient(destination, (await session.accounts.getCurrentAccount(CHAIN)).address)
  await refreshReceivedBalances(session)
  const spendable = await balanceForERC20Token(VERSION, fullWalletForID(session.info.id), NETWORK, selected.tokenAddress, true)
  const requested = maximum ? undefined : amountFromInput(value, token)
  const feeBps: bigint = await new Contract(CONFIG.proxyContract, PROXY, session.provider).getFunction('unshieldFee')()
  const evmGasType = getEVMGasTypeForTransaction(NETWORK, false)
  if (evmGasType !== EVMGasType.Type0 && evmGasType !== EVMGasType.Type1)
    throw new Error('Review the updated Railgun broadcaster gas policy before continuing.')
  const gasPrice = (await session.provider.getFeeData()).gasPrice
  if (gasPrice == null || gasPrice <= 0n) throw new Error(`${CHAIN_NAME} gas price unavailable.`)
  let gas = { evmGasType, gasEstimate: 3_000_000n, gasPrice }
  let fee = broadcasterFee(selected, gas)
  for (let attempt = 0; attempt < 3; attempt++) {
    const amount = requested ?? spendable - fee.amount
    if (amount <= 0n || amount + fee.amount > spendable)
      throw new Error(`Insufficient spendable ${token} for the withdrawal and broadcaster fee. Use Max withdrawal after fee.`)
    const amounts = [{ tokenAddress: TOKENS[token].address, amount, recipientAddress: destination }]
    const estimate = await gasEstimateForUnprovenUnshield(
      VERSION, NETWORK, session.info.id, session.key, amounts, [], gas,
      { tokenAddress: selected.tokenAddress, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) }, false,
    )
    // Round calldata gas jitter upward so a full-balance withdrawal can converge.
    const rounded = maximum ? ((estimate.gasEstimate + 9_999n) / 10_000n) * 10_000n : estimate.gasEstimate
    gas = { ...gas, gasEstimate: maximum && attempt > 0 && gas.gasEstimate > rounded ? gas.gasEstimate : rounded }
    fee = broadcasterFee(selected, gas)
    if (maximum && amount + fee.amount !== spendable) continue
    if (amount + fee.amount > spendable) throw new Error(`Insufficient spendable ${token} for the withdrawal and broadcaster fee.`)
    return { token, amounts, minimum: unshieldAmount(amount, feeBps), selected, gas, fee }
  }
  throw new Error('The withdrawal fee changed while estimating. Review the fee again.')
}

export async function executeUnshield(
  session: WalletSession,
  prepared: Awaited<ReturnType<typeof prepareUnshield>>,
  onProgress: (message: string) => void,
  submitter: PrivateSubmitter,
): Promise<string> {
  const { amounts, selected, gas, fee } = prepared
  if ((await pendingWithdrawal(session)) || (await pendingSwap(session)))
    throw new Error('A private transaction is already pending. Reconcile it before spending again.')
  broadcasterFee(selected, gas)
  await submitter.assertReady(session, selected, gas)
  await generateUnshieldProof(
    VERSION,
    NETWORK,
    session.info.id,
    session.key,
    amounts,
    [],
    fee,
    false,
    gas.gasPrice,
    (progress, status) => onProgress(`${status}: ${Math.round(progress)}%`),
  )
  const populated = await populateProvedUnshield(
    VERSION,
    NETWORK,
    session.info.id,
    amounts,
    [],
    fee,
    false,
    gas.gasPrice,
    gas,
  )
  await submitter.assertReady(session, selected, gas)
  if (
    !populated.nullifiers?.length ||
    typeof populated.transaction.to !== 'string' ||
    typeof populated.transaction.data !== 'string' ||
    getAddress(populated.transaction.to) !== getAddress(CONFIG.proxyContract) ||
    BigInt(populated.transaction.value || 0) !== 0n
  )
    throw new Error('Invalid populated withdrawal.')
  assertAtomicWithdrawal(populated.transaction.data)
  const pending = {
    token: prepared.token,
    recipient: amounts[0].recipientAddress,
    minimum: prepared.minimum.toString(),
    fromBlock: await session.provider.getBlockNumber(),
    nullifiers: populated.nullifiers.map((n) => `0x${n.replace(/^0x/, '').padStart(64, '0')}`),
    transaction: { to: populated.transaction.to, data: populated.transaction.data, value: '0' },
    minGasPrice: gas.gasPrice.toString(),
  }
  await savePendingWithdrawal(session, pending)
  const hash = await submitter.send(session, populated, selected, gas, false)
  await savePendingWithdrawal(session, { ...pending, hash })
  onProgress(`Waiting for two confirmations: ${hash}`)
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt || receipt.status !== 1)
    throw new Error(`Withdrawal unconfirmed: ${hash}. Check transaction status before retrying.`)
  assertWithdrawalReceipt(receipt, pending)
  await reconcilePendingWithdrawal(session)
  return hash
}

export function assertWithdrawalRecipient(recipient: string, ephemeral: string): void {
  const forbidden = [
    ZeroAddress,
    CONFIG.proxyContract,
    CONFIG.relayAdaptContract,
    CONFIG.relayAdapt7702Contract,
    ROUTER,
    PERMIT2,
    ...Object.values(TOKENS).map((token) => token.address),
    ephemeral,
  ].map(getAddress)
  if (forbidden.includes(getAddress(recipient)))
    throw new Error('Use a public recipient wallet, not a protocol contract or temporary account.')
}

export async function retrySavedUnshield(session: WalletSession, onProgress: (message: string) => void, submitter: PrivateSubmitter): Promise<string> {
  requireWalletSync()
  const pending = await pendingWithdrawal(session)
  if (!pending) throw new Error('No saved withdrawal to retry.')
  if (pending.hash) throw new Error('Check pending withdrawal first; a transaction hash is already saved.')
  assertAtomicWithdrawal(pending.transaction.data)
  if (await withdrawalInputsSpent(session, pending)) throw new Error('A withdrawal input is already spent. Check pending withdrawal first.')
  const selected = await selectBroadcaster(TOKENS[pending.token].address, false, onProgress)
  const evmGasType = getEVMGasTypeForTransaction(NETWORK, false)
  if (evmGasType !== EVMGasType.Type0 && evmGasType !== EVMGasType.Type1) throw new Error('Unsupported withdrawal gas policy.')
  const gas = { evmGasType, gasEstimate: 3_000_000n, gasPrice: BigInt(pending.minGasPrice) }
  const hash = await submitter.send(session, { transaction: { ...pending.transaction, value: 0n },
    nullifiers: pending.nullifiers, preTransactionPOIsPerTxidLeafPerList: {} }, selected, gas, false)
  await savePendingWithdrawal(session, { ...pending, hash })
  onProgress(`Waiting for two confirmations: ${hash}`)
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt) throw new Error(`Withdrawal unconfirmed: ${hash}. Check pending withdrawal before retrying.`)
  assertWithdrawalReceipt(receipt, pending)
  await reconcilePendingWithdrawal(session)
  return hash
}
