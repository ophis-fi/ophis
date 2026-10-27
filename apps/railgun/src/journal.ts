import { Contract, getAddress } from 'ethers'
import { fullWalletForID, getWalletTransactionHistory } from '@railgun-community/wallet'
import { ERC20, TOKENS, CONFIG, type TokenSymbol } from './config'
import { assertReceipt, assertPrivateOutput, PRIVACY, ADAPT } from './execution'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'

export interface PendingSwap {
  index: number
  account: string
  token: TokenSymbol
  npk: string
  minimum: string
  hash?: string
  executeNonce: string
  fromBlock: number
}

export async function pendingSwap(session: WalletSession): Promise<PendingSwap | undefined> {
  const stored = await readPrivateState(session, 'pendingSwap')
  if (stored === undefined) return undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('index' in stored) ||
    !Number.isSafeInteger(stored.index) ||
    !('account' in stored) ||
    typeof stored.account !== 'string' ||
    !('token' in stored) ||
    (stored.token !== 'USDC' && stored.token !== 'WETH') ||
    !('minimum' in stored) ||
    typeof stored.minimum !== 'string' ||
    !('npk' in stored) ||
    typeof stored.npk !== 'string'
  )
    throw new Error('Pending swap record is damaged. Use recovery; do not submit another swap.')
  if (
    typeof stored.index !== 'number' ||
    stored.index < 0 ||
    !('executeNonce' in stored) ||
    typeof stored.executeNonce !== 'string' ||
    !/^\d+$/.test(stored.executeNonce) ||
    !('fromBlock' in stored) ||
    typeof stored.fromBlock !== 'number' ||
    !Number.isSafeInteger(stored.fromBlock) ||
    stored.fromBlock < 0 ||
    !/^\d+$/.test(stored.minimum) ||
    !/^0x[0-9a-f]{64}$/i.test(stored.npk) ||
    ('hash' in stored &&
      stored.hash !== undefined &&
      (typeof stored.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(stored.hash)))
  )
    throw new Error('Pending swap record is damaged.')
  getAddress(stored.account)
  return stored as PendingSwap
}

export async function savePendingSwap(session: WalletSession, pending: PendingSwap): Promise<void> {
  await writePrivateState(session, 'pendingSwap', pending)
}

export async function reconcilePendingSwap(
  session: WalletSession,
  allowRecovered = false,
  acceptLeftovers = false,
): Promise<string> {
  const pending = await pendingSwap(session)
  if (!pending) return 'No pending private swap.'
  let receipt = pending.hash ? await session.provider.getTransactionReceipt(pending.hash) : null
  if (!receipt || receipt.status === 0 || (receipt.to && getAddress(receipt.to) !== getAddress(pending.account))) {
    // The SDK's startingBlock filters input-note creation, not the spend's block.
    const history = await getWalletTransactionHistory(CONFIG.chain, session.info.id, undefined)
    const matched = history.find(
      (item) =>
        (item.blockNumber == null || item.blockNumber >= pending.fromBlock) &&
        item.unshieldERC20Amounts.some(
          (amount) => amount.recipientAddress && getAddress(amount.recipientAddress) === getAddress(pending.account),
        ),
    )
    if (matched) {
      pending.hash = matched.txid.startsWith('0x') ? matched.txid : `0x${matched.txid}`
      await savePendingSwap(session, pending)
      receipt = await session.provider.getTransactionReceipt(pending.hash)
    } else if (!pending.hash)
      throw new Error(
        `Submission outcome unknown. Check recovery account ${pending.index} (${pending.account}), or cancel its pending authorization.`,
      )
  }
  if (!receipt || (await receipt.confirmations()) < 2)
    throw new Error('Pending swap needs two confirmations. Check again shortly.')
  const failedCall = receipt.logs.some(
    (log) =>
      getAddress(log.address) === getAddress(pending.account) &&
      ADAPT.parseLog({ topics: [...log.topics], data: log.data })?.name === 'CallError',
  )
  let recovered = false
  try {
    if (receipt.status !== 1) assertReceipt(receipt, pending.account)
    assertPrivateOutput(receipt, TOKENS[pending.token].address, pending.npk, BigInt(pending.minimum))
  } catch (error) {
    if (!failedCall || !allowRecovered || receipt.status !== 1) throw error
    const unshielded = receipt.logs.some((log) => {
      if (getAddress(log.address) !== getAddress(CONFIG.proxyContract)) return false
      const event = PRIVACY.parseLog({ topics: [...log.topics], data: log.data })
      return event?.name === 'Unshield' && getAddress(event.args.to) === getAddress(pending.account)
    })
    if (!unshielded) throw error
    const balances = await Promise.all(
      Object.values(TOKENS).map((token) =>
        new Contract(token.address, ERC20, session.provider).getFunction('balanceOf')(pending.account),
      ),
    )
    if (balances.some((balance) => BigInt(balance) !== 0n) && !acceptLeftovers) throw error
    recovered = true
  }
  await fullWalletForID(session.info.id).setEphemeralKeyIndexIfGreater(1n, pending.index + 1)
  await deletePrivateState(session, 'pendingSwap')
  return recovered
    ? `Failed swap reconciled after recovery. Account ${pending.index} remains accessible.`
    : `Private output confirmed. Recovery account ${pending.index} remains accessible.${failedCall ? ' A cleanup call failed; inspect the receipt.' : ''}`
}
