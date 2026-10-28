import { CHAIN, CHAIN_NAME, CONFIG, NETWORK, PERMIT2, PROXY, ROUTER, TOKENS, VERSION, type TokenSymbol } from './config'
import { getEVMGasTypeForTransaction, EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import {
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from '@railgun-community/wallet'
import { Contract, getAddress, ZeroAddress } from 'ethers'
import { broadcasterFee, validateBroadcaster, type PrivateSubmitter } from './broadcaster'
import { amountFromInput, unshieldAmount } from './recipe'
import { pendingSwap } from './journal'
import {
  assertWithdrawalReceipt,
  pendingWithdrawal,
  reconcilePendingWithdrawal,
  savePendingWithdrawal,
} from './withdrawal-journal'
import { refreshReceivedBalances, requireWalletSync, type WalletSession } from './wallet'

export async function prepareUnshield(
  session: WalletSession,
  token: TokenSymbol,
  value: string,
  recipient: string,
  selected: SelectedBroadcaster,
) {
  requireWalletSync()
  if ((await pendingWithdrawal(session)) || (await pendingSwap(session)))
    throw new Error('Resolve the pending private transaction before preparing another withdrawal.')
  validateBroadcaster(selected, TOKENS[token].address, false)
  const destination = getAddress(recipient)
  assertWithdrawalRecipient(destination, (await session.accounts.getCurrentAccount(CHAIN)).address)
  await refreshReceivedBalances(session)
  const amounts = [
    { tokenAddress: TOKENS[token].address, amount: amountFromInput(value, token), recipientAddress: destination },
  ]
  const feeBps: bigint = await new Contract(CONFIG.proxyContract, PROXY, session.provider).getFunction('unshieldFee')()
  const minimum = unshieldAmount(amounts[0].amount, feeBps)
  if (getEVMGasTypeForTransaction(NETWORK, false) !== EVMGasType.Type1)
    throw new Error('Review the updated Railgun broadcaster gas policy before continuing.')
  const gasPrice = (await session.provider.getFeeData()).gasPrice
  if (gasPrice == null) throw new Error(`${CHAIN_NAME} gas price unavailable.`)
  const gas = { evmGasType: EVMGasType.Type1 as const, gasEstimate: 3_000_000n, gasPrice }
  const estimate = await gasEstimateForUnprovenUnshield(
    VERSION,
    NETWORK,
    session.info.id,
    session.key,
    amounts,
    [],
    gas,
    { tokenAddress: selected.tokenAddress, feePerUnitGas: BigInt(selected.tokenFee.feePerUnitGas) },
    false,
  )
  const withLimit = { ...gas, gasEstimate: estimate.gasEstimate }
  const fee = broadcasterFee(selected, withLimit)
  return { token, amounts, minimum, selected, gas: withLimit, fee }
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
