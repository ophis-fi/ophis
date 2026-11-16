import { CHAIN, CHAIN_ID, CHAIN_NAME, NATIVE_SYMBOL, CONFIG, PREPAID_BROADCASTERS } from './config'
import {
  RelayAdapt7702Helper,
  RelayAdapt7702ExecutionType,
  type RelayAdapt7702Request,
} from '@railgun-community/engine'
import { fullWalletForID } from '@railgun-community/wallet'
import { Contract, getAddress, isHexString, ZeroHash } from 'ethers'
import { ADAPT, encodeRequest } from './execution'
import { pendingSwap } from './journal'
import { pendingWithdrawal } from './withdrawal-journal'
import { deletePrivateState } from './storage'
import type { WalletSession } from './wallet'
import { gasDetails } from './broadcaster'
import { assertCanonicalReceipt, readUncachedBlockHeader } from './receipt-canonical'

export const CANCELLATION_GAS_LIMIT = 300_000n

export async function cancelPendingSwap(session: WalletSession, acceptLeftovers: boolean, withdrawal = false, payerIndex?: number): Promise<string> {
  if (!acceptLeftovers)
    throw new Error('Acknowledge that public leftovers remain recoverable at the recorded account index.')
  const pending = withdrawal ? (await pendingWithdrawal(session))?.execution : await pendingSwap(session)
  if (!pending) throw new Error('No pending signed execution to cancel.')
  if (payerIndex !== undefined && (CHAIN_ID !== 42161 || !Number.isSafeInteger(payerIndex) || payerIndex < 0 || payerIndex >= pending.index))
    throw new Error('Choose an earlier recovery account from this Arbitrum wallet for cancellation gas.')
  if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error(`${CHAIN_NAME} RPC required.`)
  const account = await session.accounts.getAccount(CHAIN, pending.index)
  if (getAddress(account.address) !== getAddress(pending.account)) throw new Error('Recovery account mismatch.')
  const code = (await session.provider.getCode(account.address)).toLowerCase()
  const delegation = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
  if (code !== '0x' && code !== delegation)
    throw new Error('Unexpected recovery account delegation.')
  const nonce: bigint =
    code === '0x' ? 0n : await new Contract(account.address, ADAPT, session.provider).getFunction('nonce')()
  if (nonce <= BigInt(pending.executeNonce)) {
    const payer = payerIndex === undefined ? account : await session.accounts.getAccount(CHAIN, payerIndex)
    const alternatePayer = payerIndex !== undefined
    const payerCode = alternatePayer ? (await session.provider.getCode(payer.address)).toLowerCase() : code
    if (alternatePayer && (getAddress(payer.address) === getAddress(account.address) ||
      getAddress(payer.signer.address) !== getAddress(payer.address) || (payerCode !== '0x' && payerCode !== delegation)))
      throw new Error('Unexpected cancellation gas account or delegation.')
    if (alternatePayer && !PREPAID_BROADCASTERS[CHAIN_ID]?.maxGasPrice)
      throw new Error('The cancellation gas ceiling is unavailable. Keep the pending record.')
    if ((await session.provider.getBalance(payer.address)) === 0n)
      throw new Error(
        alternatePayer ? 'The selected recovery account has no cancellation gas. Keep the pending record.'
          : `Fund recovery account ${pending.index} (${account.address}) with ${NATIVE_SYMBOL} for cancellation gas. This creates a public link.`,
      )
    const executionDetails = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: nonce }
    const actionData = RelayAdapt7702Helper.getActionData(
      true,
      [{ to: account.address, data: ADAPT.encodeFunctionData('nonce'), value: 0n }],
      0n,
    )
    const targetNonce = await session.provider.getTransactionCount(account.address, 'pending')
    const transactionNonce = alternatePayer ? await session.provider.getTransactionCount(payer.address, 'pending') : targetNonce
    if (!Number.isSafeInteger(targetNonce) || targetNonce < 0 || !Number.isSafeInteger(transactionNonce) || transactionNonce < 0 ||
      (alternatePayer && await session.provider.getTransactionCount(payer.address, 'latest') !== transactionNonce))
      throw new Error('Cancellation account nonce changed or another payment is pending. Keep the pending record.')
    // Only a self-paying sender increments the target nonce before processing its authorization.
    const authorization = await RelayAdapt7702Helper.signEIP7702Authorization(
      account.signer,
      CONFIG.relayAdapt7702Contract,
      CHAIN,
      targetNonce + (alternatePayer ? 0 : 1),
    )
    const executionSignature = await RelayAdapt7702Helper.signExecutionAuthorization(
      account.signer,
      [],
      actionData,
      CHAIN,
      executionDetails,
    )
    const request: RelayAdapt7702Request = {
      ...executionDetails,
      authorization,
      executionSignature,
      actionData,
      transactions: [],
      ephemeralAddress: account.address,
    }
    const fee = await gasDetails(session)
    const gasLimit = CANCELLATION_GAS_LIMIT, balance = await session.provider.getBalance(payer.address)
    const ceiling = PREPAID_BROADCASTERS[CHAIN_ID]?.maxGasPrice ?? fee.maxFeePerGas
    const maxFeePerGas = [fee.maxFeePerGas, ceiling, balance / gasLimit].reduce((a, b) => a < b ? a : b)
    const maxPriorityFeePerGas = fee.maxPriorityFeePerGas < maxFeePerGas ? fee.maxPriorityFeePerGas : maxFeePerGas
    if (maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n)
      throw new Error('The recovery balance cannot cover the cancellation gas allowance. Keep the pending record.')
    const transaction = { ...encodeRequest(request), from: payer.address, chainId: CHAIN, nonce: transactionNonce,
      gasLimit, maxFeePerGas, maxPriorityFeePerGas }
    const estimate = await session.provider.estimateGas(transaction)
    if (estimate <= 0n || estimate > gasLimit)
      throw new Error('Cancellation exceeds its gas allowance. Keep the pending record.')
    if (await session.provider.getBalance(payer.address) < gasLimit * maxFeePerGas)
      throw new Error('The recovery balance changed before cancellation. Keep the pending record.')
    if (alternatePayer) {
      const [freshTargetNonce, freshPayerNonce, latestPayerNonce, freshTargetCode, freshPayerCode] = await Promise.all([
        session.provider.getTransactionCount(account.address, 'pending'), session.provider.getTransactionCount(payer.address, 'pending'),
        session.provider.getTransactionCount(payer.address, 'latest'), session.provider.getCode(account.address), session.provider.getCode(payer.address),
      ])
      if (freshTargetNonce !== targetNonce || freshPayerNonce !== transactionNonce || latestPayerNonce !== transactionNonce ||
        freshTargetCode.toLowerCase() !== code || freshPayerCode.toLowerCase() !== payerCode)
        throw new Error('Cancellation account state changed during simulation. Keep the pending record.')
    }
    const sent = await payer.signer
      .connect(session.provider)
      .sendTransaction(transaction)
    const receipt = await sent.wait(2)
    if (!receipt || receipt.status !== 1) throw new Error('Cancellation is not confirmed. Keep the pending record.')
  }
  const anchor = CHAIN_ID === 8453 ? await readUncachedBlockHeader(session.provider, 'finalized')
    : await session.provider.getBlock('latest').then(head => head && ({ number: head.number - 1, hash: head.parentHash }))
  if (!anchor || !Number.isSafeInteger(anchor.number) || anchor.number < 0 || !isHexString(anchor.hash, 32) || anchor.hash === ZeroHash)
    throw new Error('Cancellation confirmation evidence is unavailable. Keep the pending record.')
  const selector = { blockHash: anchor.hash, requireCanonical: true }
  const read = async (method: 'eth_getCode' | 'eth_call', argument: unknown): Promise<string> => {
    try {
      const result = await session.provider.send(method, [argument, selector])
      if (!isHexString(result, method === 'eth_call' ? 32 : true)) throw new Error('Invalid execution state')
      return result
    } catch { throw new Error('Cancellation state could not be verified on its canonical block. Keep the pending record.') }
  }
  if ((await read('eth_getCode', account.address)).toLowerCase() !== delegation)
    throw new Error('Cancellation needs two confirmations. Keep the pending record.')
  const advanced: bigint = ADAPT.decodeFunctionResult('nonce', await read('eth_call', {
    to: account.address, data: ADAPT.encodeFunctionData('nonce'),
  }))[0]
  if (advanced <= BigInt(pending.executeNonce))
    throw new Error('Old execution authorization is not confirmed invalid. Keep the pending record.')
  await assertCanonicalReceipt(session.provider, { blockNumber: anchor.number, blockHash: anchor.hash })
  await fullWalletForID(session.info.id).setEphemeralKeyIndexIfGreater(CHAIN, pending.index + 1)
  await deletePrivateState(session, withdrawal ? 'pendingWithdrawal' : 'pendingSwap')
  return `Old ${withdrawal ? 'withdrawal' : 'swap'} authorization invalidated. Account ${pending.index} (${pending.account}) remains recoverable; check its balances.`
}
