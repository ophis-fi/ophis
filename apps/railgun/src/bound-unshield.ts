import { Contract, getAddress, Signature, ZeroAddress, type Authorization } from 'ethers'
import { calculateGasLimit, type SelectedBroadcaster, type TransactionGasDetailsType4 } from '@railgun-community/shared-models'
import { fullWalletForID, balanceForERC20Token, gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702, ratchetEphemeralAddress } from '@railgun-community/wallet'
import { CHAIN, CHAIN_ID, CONFIG, MIN_SWAP_GAS, NETWORK, PROXY, tokenFor, VERSION, WRAPPED_SYMBOL, type TokenSymbol } from './config'
import { unusedSwapAccount } from './account'
import { broadcasterFee, capPrepaidGasPrice, gasDetails, prepaidFee, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import type { PreparedCredit } from './prepaid'
import { ADAPT, assertBoundWithdrawal, assertSameExecution, encodeRequest, simulateRequest } from './execution'
import { amountFromInput, unshieldAmount } from './recipe'
import { feeTokenFor, requireFeeBalance } from './fee-asset'
import { refreshReceivedBalances, type WalletSession } from './wallet'
import { assertWithdrawalReceipt, reconcilePendingWithdrawal, savePendingWithdrawal } from './withdrawal-journal'

export interface PreparedBoundWithdrawal {
  kind: 'TX7702'
  token: TokenSymbol
  feeToken: TokenSymbol
  amounts: { tokenAddress: string; amount: bigint; recipientAddress: string }[]
  minimum: bigint
  selected: SelectedBroadcaster
  gas: TransactionGasDetailsType4
  fee: ReturnType<typeof broadcasterFee>
  prepaid?: PreparedCredit
  account: string
  index: number
  feeBps: bigint
  output?: 'native'
  calls: { to: string; data: string; value: bigint }[]
}

export async function prepareBoundWithdrawal(session: WalletSession, token: TokenSymbol, value: string, recipient: string,
  selected: SelectedBroadcaster, maximum: boolean, nativeOutput = false, prepaid?: PreparedCredit): Promise<PreparedBoundWithdrawal> {
  const feeToken = prepaid ? WRAPPED_SYMBOL : feeTokenFor(token)
  const asset = tokenFor(token), feeAsset = tokenFor(feeToken)
  const sameAsset = getAddress(asset.address) === getAddress(feeAsset.address)
  if (nativeOutput && (CHAIN_ID !== 56 || !sameAsset)) throw new Error('Native BNB withdrawal requires private WBNB on BNB Chain.')
  if (!nativeOutput && sameAsset && !prepaid) throw new Error('A same-token withdrawal uses one atomic private proof.')
  if (!prepaid) validateBroadcaster(selected, feeAsset.address, true)
  await refreshReceivedBalances(session)
  const wallet = fullWalletForID(session.info.id)
  const principal = await balanceForERC20Token(VERSION, wallet, NETWORK, asset.address, true)
  const reserve = prepaid ? 0n : sameAsset ? principal : await balanceForERC20Token(VERSION, wallet, NETWORK, feeAsset.address, true)
  const requested = maximum ? undefined : amountFromInput(value, token)
  const account = await unusedSwapAccount(session)
  const feeBps: bigint = await new Contract(CONFIG.proxyContract, PROXY, session.provider).getFunction('unshieldFee')()
  let gas = await gasDetails(session)
  if (prepaid) {
    gas = capPrepaidGasPrice(gas, prepaid)
    await (await import('./prepaid')).assertPrepaidContext(session, selected, gas, prepaid)
  }
  let fee = prepaid ? prepaidFee(prepaid, gas) : broadcasterFee(selected, gas)
  for (let attempt = 0; attempt < 3; attempt++) {
    const amount = requested ?? principal - (!prepaid && sameAsset ? fee.amount : 0n)
    if (amount <= 0n || amount > principal) throw new Error(`Insufficient spendable ${asset.symbol} for the withdrawal.`)
    if (!prepaid) requireFeeBalance(reserve - (sameAsset ? amount : 0n), fee.amount, feeToken)
    const minimum = unshieldAmount(amount, feeBps)
    const transfer = { to: account.address, value: 0n, data: ADAPT.encodeFunctionData('transfer', [[{
      token: { tokenType: 0, tokenAddress: nativeOutput ? ZeroAddress : asset.address, tokenSubID: 0 }, to: recipient, value: minimum,
    }]]) }
    const calls = nativeOutput
      ? [{ to: account.address, value: 0n, data: ADAPT.encodeFunctionData('unwrapBase', [minimum]) }, transfer] : [transfer]
    const estimated = await gasEstimateForUnprovenCrossContractCalls7702(VERSION, NETWORK, session.info.id, session.key,
      [{ tokenAddress: asset.address, amount }], [], [], [], calls, gas,
      prepaid ? undefined : { tokenAddress: feeAsset.address, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) }, !!prepaid, MIN_SWAP_GAS)
    gas = { ...gas, gasEstimate: estimated.gasEstimate > gas.gasEstimate ? estimated.gasEstimate : gas.gasEstimate }
    if (prepaid) gas = capPrepaidGasPrice(gas, prepaid)
    fee = prepaid ? prepaidFee(prepaid, gas) : broadcasterFee(selected, gas)
    if (!prepaid && sameAsset && maximum && amount + fee.amount !== principal) continue
    if (prepaid) await (await import('./prepaid')).assertPrepaidContext(session, selected, gas, prepaid)
    else requireFeeBalance(reserve - (sameAsset ? amount : 0n), fee.amount, feeToken)
    return { kind: 'TX7702', token, feeToken, amounts: [{ tokenAddress: asset.address, amount, recipientAddress: recipient }],
      minimum, selected, gas, fee, prepaid, account: account.address, index: await wallet.getEphemeralKeyIndex(CHAIN), feeBps, calls,
      ...(nativeOutput ? { output: 'native' as const } : {}) }
  }
  throw new Error(`The withdrawal fee changed while reserving the ${feeAsset.symbol} fee. Review the quote again.`)
}

export function storedAuthorization(authorization: Authorization) {
  return { address: authorization.address, chainId: authorization.chainId.toString(), nonce: authorization.nonce.toString(),
    signature: Signature.from(authorization.signature).serialized }
}

export async function executeBoundWithdrawal(session: WalletSession, prepared: PreparedBoundWithdrawal,
  onProgress: (message: string) => void, submitter: PrivateSubmitter): Promise<string> {
  const { token, amounts, selected, gas, fee, prepaid } = prepared
  await submitter.assertReady(session, selected, gas, prepaid)
  const request = await generateCrossContractCallsProof7702(VERSION, NETWORK, session.info.id, session.key,
    amounts.map(({ tokenAddress, amount }) => ({ tokenAddress, amount })), [], [], [], prepared.calls, prepaid ? undefined : fee, !!prepaid, 0n,
    MIN_SWAP_GAS, (progress, status) => onProgress(`${status}: ${Math.round(progress)}%`))
  if (getAddress(request.ephemeralAddress) !== getAddress(prepared.account) || request.executeNonce == null)
    throw new Error('Withdrawal execution account changed. Keep the private funds; prepare another quote.')
  if (getAddress((await session.accounts.getAccount(CHAIN, prepared.index)).address) !== getAddress(request.ephemeralAddress))
    throw new Error('Recovery account does not match the signed transaction.')
  const wallet = fullWalletForID(session.info.id)
  // The SDK creates a broadcaster action with requireSuccess=false. Sign the
  // unchanged proof order again with the strict action before disclosing it.
  const actionData = { ...request.actionData, requireSuccess: true }
  const signed = await wallet.sign7702Request(session.key, CONFIG.relayAdapt7702Contract, CHAIN, request.transactions,
    actionData, Number(request.authorization.nonce), request, undefined, request.ephemeralAddress)
  const strict = { ...request, actionData, authorization: signed.authorization, executionSignature: signed.signature }
  const encoded = encodeRequest(strict)
  const transaction = { to: prepared.account, data: String(encoded.data), value: 0n, type: 4, authorizationList: [strict.authorization], chainId: CHAIN, gasLimit: calculateGasLimit(gas.gasEstimate),
    maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas }
  assertSameExecution(session, strict, transaction)
  assertBoundWithdrawal(String(transaction.data), prepared.account, token, amounts[0].recipientAddress, prepared.minimum, prepared.output, prepaid ? 'prepaid' : undefined)
  if (await new Contract(CONFIG.proxyContract, PROXY, session.provider).getFunction('unshieldFee')() !== prepared.feeBps)
    throw new Error('The withdrawal protocol fee changed. Prepare another quote before submitting.')
  await submitter.assertReady(session, selected, gas, prepaid)
  const checkedAt = { monotonic: performance.now(), wallTime: Date.now() }
  const pending = { token, feeToken: prepared.feeToken, broadcaster: selected.railgunAddress, recipient: amounts[0].recipientAddress,
    ...(prepaid ? { feeMode: 'prepaid' as const } : {}),
    ...(prepared.output ? { output: prepared.output } : {}),
    minimum: prepared.minimum.toString(), fromBlock: await session.provider.getBlockNumber(),
    nullifiers: strict.transactions.flatMap((tx) => tx.nullifiers.map(String)),
    transaction: { to: prepared.account, data: String(transaction.data), value: '0' }, minGasPrice: '0',
    execution: { index: prepared.index, account: prepared.account, executeNonce: strict.executeNonce!.toString(),
      authorization: storedAuthorization(strict.authorization), gasEstimate: gas.gasEstimate.toString(),
      maxFeePerGas: gas.maxFeePerGas.toString(), maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString() } }
  await savePendingWithdrawal(session, pending)
  await simulateRequest(session, strict, calculateGasLimit(gas.gasEstimate))
  const hash = await submitter.send(session, { transaction, nullifiers: pending.nullifiers,
    preTransactionPOIsPerTxidLeafPerList: {} }, selected, gas, true, checkedAt, prepaid)
  await savePendingWithdrawal(session, { ...pending, hash })
  await ratchetEphemeralAddress(session.info.id, NETWORK)
  onProgress(`Waiting for two confirmations: ${hash}`)
  const receipt = await session.provider.waitForTransaction(hash, 2, 180_000)
  if (!receipt) throw new Error(`Withdrawal unconfirmed: ${hash}. Keep the saved signed execution.`)
  assertWithdrawalReceipt(receipt, pending)
  await reconcilePendingWithdrawal(session)
  return hash
}
