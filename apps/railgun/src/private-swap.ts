import {
  fullWalletForID,
  balanceForERC20Token,
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
  ratchetEphemeralAddress,
} from '@railgun-community/wallet'
import { getAddress } from 'ethers'
import { calculateGasLimit, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { broadcasterFee, gasDetails, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import { MIN_SWAP_GAS, NETWORK, TOKENS, VERSION } from './config'
import { assertExecutionNetwork, assertSameExecution, expectedOutputNpk, simulateRequest } from './execution'
import { pendingSwap, savePendingSwap, reconcilePendingSwap } from './journal'
import { pendingWithdrawal } from './withdrawal-journal'
import { assertQuoteFresh, type SwapQuote } from './recipe'
import { requireWalletSync, type WalletSession } from './wallet'
import { unusedSwapAccount } from './account'

export async function preparePrivateSwap(session: WalletSession, quote: SwapQuote, selected: SelectedBroadcaster) {
  requireWalletSync()
  if ((await pendingSwap(session)) || (await pendingWithdrawal(session)))
    throw new Error('Resolve the pending private transaction in recovery before preparing another.')
  const account = await unusedSwapAccount(session)
  assertQuoteFresh(quote, account.address)
  validateBroadcaster(selected, TOKENS[quote.sell].address, true)
  const gas = await gasDetails(session)
  const unshields = [{ tokenAddress: TOKENS[quote.sell].address, amount: quote.amount }]
  const reshields = [TOKENS[quote.sell], TOKENS[quote.buy]].map((token) => ({
    tokenAddress: token.address,
    recipientAddress: session.info.railgunAddress,
  }))
  const estimated = await gasEstimateForUnprovenCrossContractCalls7702(
    VERSION,
    NETWORK,
    session.info.id,
    session.key,
    unshields,
    [],
    reshields,
    [],
    quote.calls,
    gas,
    { tokenAddress: selected.tokenAddress, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) },
    false,
    MIN_SWAP_GAS,
  )
  const gasWithLimit = { ...gas, gasEstimate: estimated.gasEstimate }
  const fee = broadcasterFee(selected, gasWithLimit)
  const spendable = await balanceForERC20Token(
    VERSION,
    fullWalletForID(session.info.id),
    NETWORK,
    selected.tokenAddress,
    true,
  )
  if (spendable < quote.amount + fee.amount)
    throw new Error('Insufficient spendable balance for the swap and broadcaster fee.')
  return { quote, selected, gas: gasWithLimit, fee, unshields, reshields }
}

export async function executePrivateSwap(
  session: WalletSession,
  prepared: Awaited<ReturnType<typeof preparePrivateSwap>>,
  onProgress: (message: string) => void,
  submitter: PrivateSubmitter,
): Promise<string> {
  const { quote, selected, gas, fee, unshields, reshields } = prepared
  if ((await pendingSwap(session)) || (await pendingWithdrawal(session)))
    throw new Error('A private transaction is already pending. Reconcile it before spending again.')
  assertQuoteFresh(quote, (await session.accounts.getCurrentAccount(1n)).address)
  broadcasterFee(selected, gas)
  await submitter.assertReady(session, selected, gas)
  const index = await fullWalletForID(session.info.id).getEphemeralKeyIndex(1n)
  const request = await generateCrossContractCallsProof7702(
    VERSION,
    NETWORK,
    session.info.id,
    session.key,
    unshields,
    [],
    reshields,
    [],
    quote.calls,
    fee,
    false,
    0n,
    MIN_SWAP_GAS,
    (progress, status) => onProgress(`${status}: ${Math.round(progress)}%`),
  )
  if (getAddress(request.ephemeralAddress) !== getAddress(quote.account))
    throw new Error('Private account changed while proving.')
  if (getAddress((await session.accounts.getAccount(1n, index)).address) !== getAddress(request.ephemeralAddress))
    throw new Error('Recovery account does not match the signed transaction.')
  assertQuoteFresh(quote, request.ephemeralAddress)
  await submitter.assertReady(session, selected, gas)
  await assertExecutionNetwork(session)
  const populated = await populateProvedCrossContractCalls(
    VERSION,
    NETWORK,
    session.info.id,
    unshields,
    [],
    reshields,
    [],
    quote.calls,
    fee,
    false,
    0n,
    gas,
  )
  assertSameExecution(session, request, populated.transaction)
  if (request.executeNonce == null) throw new Error('Nonce-protected Railgun execution is required.')
  const pending = {
    index,
    account: request.ephemeralAddress,
    token: quote.buy,
    minimum: (quote.minimum - (quote.minimum * quote.shieldFee) / 10_000n).toString(),
    npk: expectedOutputNpk(request, TOKENS[quote.buy].address),
    executeNonce: request.executeNonce.toString(),
    fromBlock: await session.provider.getBlockNumber(),
  }
  await savePendingSwap(session, pending)
  // Simulation discloses a signed executable batch to the trusted RPC.
  onProgress('Simulating the proved swap…')
  await simulateRequest(session, request, calculateGasLimit(gas.gasEstimate))
  const hash = await submitter.send(session, populated, selected, gas, true)
  await savePendingSwap(session, { ...pending, hash })
  await ratchetEphemeralAddress(session.info.id, NETWORK)
  onProgress(`Waiting for two confirmations: ${hash}`)
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt) throw new Error(`Confirmation pending: ${hash}. Check recovery before retrying.`)
  onProgress(await reconcilePendingSwap(session))
  return hash
}
