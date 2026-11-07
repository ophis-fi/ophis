import { CHAIN, CHAIN_ID, CHAIN_NAME, CONFIG, NETWORK, PERMIT2, PILOT_WITHDRAWAL_RECIPIENT, PROXY, ROUTER, TOKENS, tokenFor, VERSION, type TokenSymbol } from './config'
import { calculateGasLimit, getEVMGasTypeForTransaction, EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { RelayAdapt7702ExecutionType } from '@railgun-community/engine'
import {
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
  fullWalletForID,
  balanceForERC20Token,
} from '@railgun-community/wallet'
import { authorizationify, Contract, getAddress, ZeroAddress } from 'ethers'
import { broadcasterFee, selectBroadcaster, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import { amountFromInput, unshieldAmount } from './recipe'
import { pendingSwap } from './journal'
import { ADAPT, assertAtomicWithdrawal, assertBoundWithdrawal, simulateRequest } from './execution'
import {
  assertWithdrawalReceipt,
  pendingWithdrawal,
  reconcilePendingWithdrawal,
  savePendingWithdrawal,
  withdrawalInputsSpent,
  type PendingWithdrawal,
} from './withdrawal-journal'
import { refreshReceivedBalances, requireWalletSync, type WalletSession } from './wallet'
import { feeTokenFor, requireFeeBalance, usesBoundWithdrawal } from './fee-asset'
import { executeBoundWithdrawal, prepareBoundWithdrawal } from './bound-unshield'

export async function prepareUnshield(
  session: WalletSession,
  token: TokenSymbol,
  value: string,
  recipient: string,
  selected: SelectedBroadcaster,
  maximum = false,
  nativeOutput = false,
) {
  requireWalletSync()
  if ((await pendingWithdrawal(session)) || (await pendingSwap(session)))
    throw new Error('Resolve the pending private transaction before preparing another withdrawal.')
  const feeToken = feeTokenFor(token)
  const asset = tokenFor(token), feeAsset = tokenFor(feeToken)
  const sameAsset = getAddress(asset.address) === getAddress(feeAsset.address)
  if (nativeOutput && (CHAIN_ID !== 56 || getAddress(asset.address) !== getAddress(tokenFor('WBNB').address)))
    throw new Error('Native BNB withdrawal requires private WBNB on BNB Chain.')
  validateBroadcaster(selected, feeAsset.address, usesBoundWithdrawal(token, nativeOutput))
  const destination = getAddress(recipient)
  if (PILOT_WITHDRAWAL_RECIPIENT &&
    (token !== 'USDC' || destination !== getAddress(PILOT_WITHDRAWAL_RECIPIENT)))
    throw new Error('This pilot withdraws USDC to its selected public recipient. Choose USDC before preparing a proof.')
  assertWithdrawalRecipient(destination, (await session.accounts.getCurrentAccount(CHAIN)).address)
  if (usesBoundWithdrawal(token, nativeOutput)) return prepareBoundWithdrawal(session, token, value, destination, selected, maximum, nativeOutput)
  await refreshReceivedBalances(session)
  const wallet = fullWalletForID(session.info.id)
  const spendable = await balanceForERC20Token(VERSION, wallet, NETWORK, asset.address, true)
  const feeBalance = sameAsset ? spendable : await balanceForERC20Token(VERSION, wallet, NETWORK, feeAsset.address, true)
  const requested = maximum ? undefined : amountFromInput(value, token)
  const feeBps: bigint = await new Contract(CONFIG.proxyContract, PROXY, session.provider).getFunction('unshieldFee')()
  const evmGasType = getEVMGasTypeForTransaction(NETWORK, false)
  if (evmGasType !== EVMGasType.Type0 && evmGasType !== EVMGasType.Type1)
    throw new Error('Review the updated Railgun broadcaster gas policy before continuing.')
  let gasPrice = (await session.provider.getFeeData()).gasPrice
  if (gasPrice == null || gasPrice <= 0n) throw new Error(`${CHAIN_NAME} gas price unavailable.`)
  if (CHAIN_ID === 1) {
    const block = await session.provider.getBlock('latest')
    if (block?.baseFeePerGas == null) throw new Error(`${CHAIN_NAME} base fee unavailable.`)
    // Match the broadcaster's positive-tip floor before committing the private fee.
    if (gasPrice < block.baseFeePerGas + 1n) gasPrice = block.baseFeePerGas + 1n
  }
  let gas = { evmGasType, gasEstimate: 3_000_000n, gasPrice }
  let fee = broadcasterFee(selected, gas)
  for (let attempt = 0; attempt < 3; attempt++) {
    const amount = requested ?? spendable - (sameAsset ? fee.amount : 0n)
    if (!sameAsset) requireFeeBalance(feeBalance, fee.amount, feeToken)
    if (amount <= 0n || amount + (sameAsset ? fee.amount : 0n) > spendable)
      throw new Error(`Insufficient spendable ${token} for the withdrawal and broadcaster fee. Use Max withdrawal after fee.`)
    const amounts = [{ tokenAddress: asset.address, amount, recipientAddress: destination }]
    const estimate = await gasEstimateForUnprovenUnshield(
      VERSION, NETWORK, session.info.id, session.key, amounts, [], gas,
      { tokenAddress: selected.tokenAddress, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) }, false,
    )
    // Round calldata gas jitter upward so a full-balance withdrawal can converge.
    const rounded = maximum ? ((estimate.gasEstimate + 9_999n) / 10_000n) * 10_000n : estimate.gasEstimate
    gas = { ...gas, gasEstimate: maximum && attempt > 0 && gas.gasEstimate > rounded ? gas.gasEstimate : rounded }
    fee = broadcasterFee(selected, gas)
    if (!sameAsset) requireFeeBalance(feeBalance, fee.amount, feeToken)
    if (maximum && sameAsset && amount + fee.amount !== spendable) continue
    if (amount + (sameAsset ? fee.amount : 0n) > spendable) throw new Error(`Insufficient spendable ${token} for the withdrawal and broadcaster fee.`)
    return { kind: 'COMMON' as const, token, feeToken, amounts, minimum: unshieldAmount(amount, feeBps), selected, gas, fee, output: undefined }
  }
  throw new Error('The withdrawal fee changed while estimating. Review the fee again.')
}

export async function executeUnshield(
  session: WalletSession,
  prepared: Awaited<ReturnType<typeof prepareUnshield>>,
  onProgress: (message: string) => void,
  submitter: PrivateSubmitter,
): Promise<string> {
  requireWalletSync()
  if ((await pendingWithdrawal(session)) || (await pendingSwap(session)))
    throw new Error('A private transaction is already pending. Reconcile it before spending again.')
  if (prepared.kind === 'TX7702') return executeBoundWithdrawal(session, prepared, onProgress, submitter)
  const { amounts, selected, gas, fee } = prepared
  validateBroadcaster(selected, tokenFor(feeTokenFor(prepared.token)).address, false)
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
  assertAtomicWithdrawal(populated.transaction.data, feeTokenFor(prepared.token))
  const pending = {
    token: prepared.token,
    feeToken: feeTokenFor(prepared.token),
    broadcaster: selected.railgunAddress,
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
  if (pending.execution) return retryBoundWithdrawal(session, pending, onProgress, submitter)
  // Older proofs retain their original fee token; never re-label or re-prove them.
  const feeToken = pending.feeToken ?? pending.token
  if (CHAIN_ID === 56 && (feeToken !== 'WBNB' || !pending.broadcaster))
    throw new Error('This saved withdrawal uses a retired broadcaster fee token. Keep its proof and use public-wallet recovery; do not prepare another withdrawal until it is resolved.')
  assertAtomicWithdrawal(pending.transaction.data, feeToken)
  if (await withdrawalInputsSpent(session, pending)) throw new Error('A withdrawal input is already spent. Check pending withdrawal first.')
  const selected = await selectBroadcaster(tokenFor(feeToken).address, false, onProgress, pending.broadcaster)
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

async function retryBoundWithdrawal(session: WalletSession, pending: PendingWithdrawal, onProgress: (message: string) => void,
  submitter: PrivateSubmitter): Promise<string> {
  const e = pending.execution!
  if (!pending.broadcaster) throw new Error('The original broadcaster identity is missing. Keep the signed withdrawal for recovery.')
  assertBoundWithdrawal(pending.transaction.data, e.account, pending.token, pending.recipient, BigInt(pending.minimum), pending.output)
  if (await withdrawalInputsSpent(session, pending)) throw new Error('A saved input is spent. Check the pending withdrawal and recovery account first.')
  const authorization = authorizationify(e.authorization)
  const [transactions, actionData, , executionSignature] = ADAPT.decodeFunctionData('execute', pending.transaction.data)
  const request = { transactions, actionData, executionSignature, authorization, ephemeralAddress: e.account,
    executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: BigInt(e.executeNonce) }
  const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: BigInt(e.gasEstimate), maxFeePerGas: BigInt(e.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(e.maxPriorityFeePerGas) }
  if (!pending.feeToken || pending.feeToken !== feeTokenFor(pending.token))
    throw new Error('The saved withdrawal fee asset differs from its policy. Keep its signed proof for recovery.')
  const selected = await selectBroadcaster(tokenFor(pending.feeToken).address, true, onProgress, pending.broadcaster)
  await submitter.assertReady(session, selected, gas)
  const checkedAt = { monotonic: performance.now(), wallTime: Date.now() }
  await simulateRequest(session, request, calculateGasLimit(gas.gasEstimate))
  const hash = await submitter.send(session, { transaction: { ...pending.transaction, value: 0n, type: 4, chainId: CHAIN,
    authorizationList: [authorization], gasLimit: calculateGasLimit(gas.gasEstimate), maxFeePerGas: gas.maxFeePerGas,
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas }, nullifiers: pending.nullifiers, preTransactionPOIsPerTxidLeafPerList: {} }, selected, gas, true, checkedAt)
  await savePendingWithdrawal(session, { ...pending, hash })
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt) throw new Error(`Withdrawal unconfirmed: ${hash}. Keep the saved signed execution.`)
  assertWithdrawalReceipt(receipt, pending)
  await reconcilePendingWithdrawal(session)
  return hash
}
