import { CHAIN, CHAIN_NAME, tokenFor, MIN_SWAP_GAS, NETWORK, TOKENS, VERSION, type TokenSymbol } from './config'
import {
  fullWalletForID,
  balanceForERC20Token,
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
  ratchetEphemeralAddress,
} from '@railgun-community/wallet'
import { formatUnits, getAddress } from 'ethers'
import { calculateGasLimit, type SelectedBroadcaster } from '@railgun-community/shared-models'
import { broadcasterFee, capGasPrice, gasDetails, minimumGasPrice, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import { assertExecutionNetwork, assertSameExecution, expectedOutputNpk, simulateRequest } from './execution'
import { pendingSwap, savePendingSwap, reconcilePendingSwap } from './journal'
import { pendingWithdrawal } from './withdrawal-journal'
import { assertFinalQuoteFresh, assertQuoteFresh, quoteSwap, revalidateSwapQuote, type SwapQuote } from './recipe'
import { refreshReceivedBalances, requireWalletSync, type WalletSession } from './wallet'
import { unusedSwapAccount } from './account'
import { feeTokenFor, requireFeeBalance } from './fee-asset'

export async function preparePrivateSwap(session: WalletSession, quote: SwapQuote, selected: SelectedBroadcaster) {
  requireWalletSync()
  if ((await pendingSwap(session)) || (await pendingWithdrawal(session)))
    throw new Error('Resolve the pending private transaction in recovery before preparing another.')
  const account = await unusedSwapAccount(session)
  assertQuoteFresh(quote, account.address)
  const feeToken = feeTokenFor(quote.sell)
  const sameAsset = feeToken === quote.sell
  validateBroadcaster(selected, TOKENS[feeToken].address, true)
  await refreshReceivedBalances(session)
  let gas = await gasDetails(session)
  const recommendedMaxFeePerGas = gas.maxFeePerGas
  const wallet = fullWalletForID(session.info.id)
  const balances = async () => {
    const principal = await balanceForERC20Token(VERSION, wallet, NETWORK, TOKENS[quote.sell].address, true)
    const reserve = sameAsset ? principal : await balanceForERC20Token(VERSION, wallet, NETWORK, TOKENS[feeToken].address, true)
    return { principal, reserve }
  }
  let available = await balances()
  const requireBalances = (fee: bigint, minimum: boolean) => {
    if (sameAsset) return requireSwapBalance(available.principal, quote.amount, fee, quote.sell, minimum)
    if (available.principal < quote.amount) throw new Error(`Insufficient spendable ${quote.sell} for the swap amount.`)
    requireFeeBalance(available.reserve, fee, feeToken)
  }
  const unshields = [{ tokenAddress: TOKENS[quote.sell].address, amount: quote.amount }]
  const reshields = [...new Set([quote.sell, quote.buy, ...(quote.route?.tokens || [])])].map((symbol) => ({
    tokenAddress: tokenFor(symbol).address,
    recipientAddress: session.info.railgunAddress,
  }))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const networkPrice = await minimumGasPrice(session, gas)
    const minimumFee = broadcasterFee(selected, { ...gas, maxFeePerGas: networkPrice })
    requireBalances(minimumFee.amount, attempt === 0)
    const budget = sameAsset ? available.principal - quote.amount : available.reserve
    gas = capGasPrice(gas, selected, budget)
    if (gas.maxFeePerGas < networkPrice) throw new Error(`${CHAIN_NAME} gas price changed. Request a fresh quote.`)
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
    if (estimated.gasEstimate < MIN_SWAP_GAS) throw new Error('SDK gas estimate is below the required swap allowance.')
    let estimate = estimated.gasEstimate
    // Calldata bytes jitter between estimates; round upward so an exact fee cap converges.
    if (gas.maxFeePerGas < recommendedMaxFeePerGas) estimate = ((estimate + 9_999n) / 10_000n) * 10_000n
    gas = { ...gas, gasEstimate: estimate > gas.gasEstimate ? estimate : gas.gasEstimate }
    const fee = broadcasterFee(selected, gas)
    available = await balances()
    if (available.principal >= quote.amount && available.reserve >= fee.amount + (sameAsset ? quote.amount : 0n)) {
      if (gas.maxFeePerGas < await minimumGasPrice(session, gas))
        throw new Error(`${CHAIN_NAME} gas price changed. Request a fresh quote.`)
      return { quote, selected, gas, fee, feeToken, unshields, reshields, gasCapped: gas.maxFeePerGas < recommendedMaxFeePerGas }
    }
    if (!sameAsset) requireBalances(fee.amount, false)
    if (available.principal <= quote.amount || capGasPrice(gas, selected, available.principal - quote.amount).maxFeePerGas >= gas.maxFeePerGas)
      requireSwapBalance(available.principal, quote.amount, fee.amount, quote.sell, false)
  }
  throw new Error('Gas estimate kept changing while fitting the fee budget. Request a fresh quote.')
}

export async function prepareMaxPrivateSwap(session: WalletSession, sell: TokenSymbol, selected: SelectedBroadcaster, budget?: bigint, buy?: TokenSymbol) {
  requireWalletSync()
  await refreshReceivedBalances(session)
  let amount = await balanceForERC20Token(VERSION, fullWalletForID(session.info.id), NETWORK, TOKENS[sell].address, true)
  if (budget != null && budget < amount) amount = budget
  if (amount <= 0n) throw new Error(`No spendable ${sell} is available for a swap.`)
  const limit = amount
  if (feeTokenFor(sell) !== sell) {
    const account = await unusedSwapAccount(session)
    const quote = await quoteSwap(session.provider, sell, formatUnits(amount, TOKENS[sell].decimals), account.address, buy)
    const prepared = await preparePrivateSwap(session, quote, selected)
    if (prepared.quote.amount > limit) throw new Error('The swap amount exceeds the remaining principal budget.')
    return prepared
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const account = await unusedSwapAccount(session)
    const quote = await quoteSwap(session.provider, sell, formatUnits(amount, TOKENS[sell].decimals), account.address, buy)
    try {
      const prepared = await preparePrivateSwap(session, quote, selected)
      if (prepared.quote.amount + prepared.fee.amount > limit)
        throw new SwapBalanceError('The quoted fee exceeds the remaining swap budget.', limit, prepared.fee.amount)
      return prepared
    } catch (error) {
      if (!(error instanceof SwapBalanceError)) throw error
      const available = error.spendable < limit ? error.spendable : limit
      // Give Max room for price changes instead of pinning its cap to the current base fee.
      const feeWithHeadroom = (error.fee * 125n + 99n) / 100n
      const remaining = available - feeWithHeadroom
      if (remaining <= 0n && error.fee < available)
        throw new Error('No positive Max swap fits with 25% fee headroom. A smaller fixed-amount quote may still fit.')
      if (remaining <= 0n || remaining >= amount) throw error
      // A smaller amount can change input notes and gas, so rebuild and recheck the entire quote.
      amount = remaining
    }
  }
  throw new Error('Balance or broadcaster fee kept changing. Request a fresh quote.')
}

export class SwapBalanceError extends Error {
  constructor(message: string, readonly spendable: bigint, readonly fee: bigint) {
    super(message)
  }
}

function requireSwapBalance(spendable: bigint, amount: bigint, fee: bigint, token: TokenSymbol, minimum: boolean): void {
  if (spendable >= amount + fee) return
  const format = (value: bigint): string => `${formatUnits(value, TOKENS[token].decimals)} ${token}`
  throw new SwapBalanceError(
    `Spendable private balance: ${format(spendable)}.\nSwap amount: ${format(amount)}.\n` +
    `${minimum ? 'Minimum broadcaster reserve' : 'Broadcaster fee'}: ${format(fee)}.\n` +
    `Required private balance: ${minimum ? 'at least ' : ''}${format(amount + fee)}.\n` +
    (spendable > 0n && fee >= spendable ? 'This quoted fee alone uses the entire spendable balance or more.\n' : '') +
    (spendable > fee ? 'Use Max swap after fee to calculate an amount with the broadcaster fee reserved.\n' : '') +
    'Only shielded funds marked Spendable can pay for this swap and its fee; public wallet funds and pending deposits do not count.',
    spendable,
    fee,
  )
}

export async function executePrivateSwap(
  session: WalletSession,
  prepared: Awaited<ReturnType<typeof preparePrivateSwap>>,
  onProgress: (message: string) => void,
  submitter: PrivateSubmitter,
): Promise<string> {
  requireWalletSync()
  const { quote, selected, gas, fee, unshields, reshields } = prepared
  validateBroadcaster(selected, TOKENS[feeTokenFor(quote.sell)].address, true)
  if ((await pendingSwap(session)) || (await pendingWithdrawal(session)))
    throw new Error('A private transaction is already pending. Reconcile it before spending again.')
  assertQuoteFresh(quote, (await session.accounts.getCurrentAccount(CHAIN)).address)
  broadcasterFee(selected, gas)
  await submitter.assertReady(session, selected, gas)
  const index = await fullWalletForID(session.info.id).getEphemeralKeyIndex(CHAIN)
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
  if (getAddress((await session.accounts.getAccount(CHAIN, index)).address) !== getAddress(request.ephemeralAddress))
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
  onProgress('Re-checking the selected route price…')
  const checkedAt = await revalidateSwapQuote(session.provider, quote)
  const inputs = request.transactions.flatMap((transaction) => transaction.nullifiers.map((n) => ({
    tree: Number(transaction.boundParams.treeNumber),
    nullifier: `0x${String(n).replace(/^0x/, '').padStart(64, '0')}`,
  })))
  if (!populated.nullifiers?.length || !inputs.length) throw new Error('Private swap has no spend nullifiers.')
  const pending = {
    index,
    account: request.ephemeralAddress,
    token: quote.buy,
    feeToken: feeTokenFor(quote.sell),
    minimum: (quote.minimum - (quote.minimum * quote.shieldFee) / 10_000n).toString(),
    npk: expectedOutputNpk(request, TOKENS[quote.buy].address),
    executeNonce: request.executeNonce.toString(),
    fromBlock: await session.provider.getBlockNumber(),
    inputs,
  }
  assertFinalQuoteFresh(checkedAt)
  await savePendingSwap(session, pending)
  // Simulation discloses a signed executable batch to the trusted RPC.
  assertFinalQuoteFresh(checkedAt)
  onProgress('Simulating the proved swap…')
  await simulateRequest(session, request, calculateGasLimit(gas.gasEstimate))
  assertQuoteFresh(quote, request.ephemeralAddress)
  assertFinalQuoteFresh(checkedAt)
  const hash = await submitter.send(session, populated, selected, gas, true, checkedAt)
  await savePendingSwap(session, { ...pending, hash })
  await ratchetEphemeralAddress(session.info.id, NETWORK)
  onProgress(`Waiting for two confirmations: ${hash}`)
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt) throw new Error(`Confirmation pending: ${hash}. Check recovery before retrying.`)
  onProgress(await reconcilePendingSwap(session))
  return hash
}
