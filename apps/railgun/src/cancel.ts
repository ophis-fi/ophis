import {
  RelayAdapt7702Helper,
  RelayAdapt7702ExecutionType,
  type RelayAdapt7702Request,
} from '@railgun-community/engine'
import { fullWalletForID } from '@railgun-community/wallet'
import { Contract, getAddress } from 'ethers'
import { CONFIG } from './config'
import { ADAPT, encodeRequest } from './execution'
import { pendingSwap } from './journal'
import { deletePrivateState } from './storage'
import type { WalletSession } from './wallet'

export async function cancelPendingSwap(session: WalletSession, acceptLeftovers: boolean): Promise<string> {
  if (!acceptLeftovers)
    throw new Error('Acknowledge that public leftovers remain recoverable at the recorded account index.')
  const pending = await pendingSwap(session)
  if (!pending) throw new Error('No pending swap to cancel.')
  if ((await session.provider.getNetwork()).chainId !== 1n) throw new Error('Ethereum RPC required.')
  const account = await session.accounts.getAccount(1n, pending.index)
  if (getAddress(account.address) !== getAddress(pending.account)) throw new Error('Recovery account mismatch.')
  const code = (await session.provider.getCode(account.address)).toLowerCase()
  const delegation = `0xef0100${CONFIG.relayAdapt7702Contract.slice(2).toLowerCase()}`
  if (code !== '0x' && code !== delegation)
    throw new Error('Unexpected recovery account delegation.')
  const nonce: bigint =
    code === '0x' ? 0n : await new Contract(account.address, ADAPT, session.provider).getFunction('nonce')()
  if (nonce <= BigInt(pending.executeNonce)) {
    if ((await session.provider.getBalance(account.address)) === 0n)
      throw new Error(
        `Fund recovery account ${pending.index} (${account.address}) with ETH for cancellation gas. This creates a public link.`,
      )
    const executionDetails = { executionType: RelayAdapt7702ExecutionType.ExecuteWithNonce, executeNonce: nonce }
    const actionData = RelayAdapt7702Helper.getActionData(
      true,
      [{ to: account.address, data: ADAPT.encodeFunctionData('nonce'), value: 0n }],
      0n,
    )
    // The transaction sender's nonce increments before its own authorization is processed.
    const transactionNonce = await session.provider.getTransactionCount(account.address, 'pending')
    const authorization = await RelayAdapt7702Helper.signEIP7702Authorization(
      account.signer,
      CONFIG.relayAdapt7702Contract,
      1n,
      transactionNonce + 1,
    )
    const executionSignature = await RelayAdapt7702Helper.signExecutionAuthorization(
      account.signer,
      [],
      actionData,
      1n,
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
    const sent = await account.signer
      .connect(session.provider)
      .sendTransaction({ ...encodeRequest(request), nonce: transactionNonce, gasLimit: 300_000n })
    const receipt = await sent.wait(2)
    if (!receipt || receipt.status !== 1) throw new Error('Cancellation is not confirmed. Keep the pending record.')
  }
  const confirmedBlock = Number(BigInt(await session.provider.send('eth_blockNumber', []))) - 1
  if (confirmedBlock < 0 || (await session.provider.getCode(account.address, confirmedBlock)).toLowerCase() !== delegation)
    throw new Error('Cancellation needs two confirmations. Keep the pending record.')
  const advanced: bigint = await new Contract(account.address, ADAPT, session.provider).getFunction('nonce')({
    blockTag: confirmedBlock,
  })
  if (advanced <= BigInt(pending.executeNonce))
    throw new Error('Old execution authorization is not confirmed invalid. Keep the pending record.')
  await fullWalletForID(session.info.id).setEphemeralKeyIndexIfGreater(1n, pending.index + 1)
  await deletePrivateState(session, 'pendingSwap')
  return `Old swap authorization invalidated. Account ${pending.index} (${pending.account}) remains recoverable; check its balances.`
}
