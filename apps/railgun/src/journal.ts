import { CHAIN_ID, isTokenSymbol, CHAIN, ERC20, TOKENS, CONFIG, ROUTE_INTERMEDIATES, type TokenSymbol } from './config'
import { Contract, getAddress } from 'ethers'
import { fullWalletForID, getWalletTransactionHistory } from '@railgun-community/wallet'
import { assertReceipt, assertPrivateOutput, PRIVACY, ADAPT } from './execution'
import { deletePrivateState, readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'

export interface PendingSwap {
  chainId?: number
  index: number
  account: string
  token: TokenSymbol
  feeToken?: TokenSymbol
  feeMode?: 'prepaid'
  recoveryTokens?: TokenSymbol[]
  npk: string
  minimum: string
  hash?: string
  executeNonce: string
  fromBlock: number
  inputs?: { tree: number; nullifier: string }[]
}

function recoveryTokens(pending: PendingSwap): TokenSymbol[] {
  // Legacy records predate the catalog; unrelated imports must never expand their cleanup scan.
  if (!Object.hasOwn(pending, 'recoveryTokens')) return [...new Set([...ROUTE_INTERMEDIATES, pending.token])]
  const tokens = pending.recoveryTokens
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 8 || !tokens.every(isTokenSymbol) ||
    new Set(tokens).size !== tokens.length || !tokens.includes(pending.token) ||
    (pending.feeToken !== undefined && !tokens.includes(pending.feeToken)))
    throw new Error('Saved swap recovery assets are damaged. Keep the record and repair it before spending.')
  return tokens
}

export async function pendingSwap(session: WalletSession): Promise<PendingSwap | undefined> {
  const stored = await readPrivateState(session, 'pendingSwap')
  if (stored === undefined) return undefined
  if (
    !stored ||
    typeof stored !== 'object' ||
    ('chainId' in stored ? stored.chainId !== CHAIN_ID : CHAIN_ID !== 1) ||
    !('index' in stored) ||
    !Number.isSafeInteger(stored.index) ||
    !('account' in stored) ||
    typeof stored.account !== 'string' ||
    !('token' in stored) ||
    !isTokenSymbol(stored.token) ||
    ('feeToken' in stored && !isTokenSymbol(stored.feeToken)) ||
    ('feeMode' in stored && stored.feeMode !== 'prepaid') ||
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
    ('inputs' in stored && (!Array.isArray(stored.inputs) || !stored.inputs.length || stored.inputs.length > 128 ||
      stored.inputs.some((input) => !input || typeof input !== 'object' || !Number.isInteger(input.tree) ||
        input.tree < 0 || input.tree > 65535 || typeof input.nullifier !== 'string' || !/^0x[0-9a-f]{64}$/i.test(input.nullifier)))) ||
    ('hash' in stored &&
      stored.hash !== undefined &&
      (typeof stored.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(stored.hash)))
  )
    throw new Error('Pending swap record is damaged.')
  getAddress(stored.account)
  recoveryTokens(stored as PendingSwap)
  return stored as PendingSwap
}

export async function savePendingSwap(session: WalletSession, pending: PendingSwap): Promise<void> {
  if (pending.chainId !== undefined && pending.chainId !== CHAIN_ID) throw new Error('Pending swap network changed.')
  recoveryTokens(pending)
  await writePrivateState(session, 'pendingSwap', { ...pending, chainId: CHAIN_ID })
}

export async function reconcilePendingSwap(
  session: WalletSession,
  allowRecovered = false,
  acceptLeftovers = false,
): Promise<string> {
  const pending = await pendingSwap(session)
  if (!pending) return 'No pending private swap.'
  const account = await session.accounts.getAccount(CHAIN, pending.index)
  if (getAddress(account.address) !== getAddress(pending.account)) throw new Error('Recovery account mismatch.')
  if (!pending.inputs?.length)
    throw new Error('This older swap record has no saved input binding. Use recovery or cancel its authorization; the record has been preserved.')
  let receipt = pending.hash ? await session.provider.getTransactionReceipt(pending.hash) : null
  if (!receipt || receipt.status === 0) {
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
  const nullifiers = receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== getAddress(CONFIG.proxyContract)) return []
    const event = PRIVACY.parseLog({ topics: [...log.topics], data: log.data })
    return event?.name === 'Nullified' ? [...event.args.nullifier].map((n: string) => `${event.args[0]}:${n.toLowerCase()}`) : []
  })
  if (!(receipt.blockNumber >= pending.fromBlock) ||
    !pending.inputs.every((input) => nullifiers.includes(`${input.tree}:${input.nullifier.toLowerCase()}`)))
    throw new Error('The saved swap inputs are not confirmed in this transaction.')
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
    recovered = true
  }
  if (failedCall && !acceptLeftovers) {
    const balances = await Promise.all(
      recoveryTokens(pending).map((id) =>
        new Contract(TOKENS[id].address, ERC20, session.provider).getFunction('balanceOf')(pending.account, { gasLimit: 100_000n }),
      ),
    ).catch(() => { throw new Error(`Recovery account ${pending.index} asset balances could not be verified. Keep the record; recover its assets or explicitly accept leftovers.`) })
    if (balances.some((balance) => BigInt(balance) !== 0n))
      throw new Error(`Recovery account ${pending.index} still holds funds after a failed cleanup call. Recover them before reconciling, or explicitly accept leftovers.`)
  }
  await fullWalletForID(session.info.id).setEphemeralKeyIndexIfGreater(CHAIN, pending.index + 1)
  await deletePrivateState(session, 'pendingSwap')
  return recovered
    ? `Failed swap reconciled after recovery. Account ${pending.index} remains accessible.`
    : `Private output confirmed. Recovery account ${pending.index} remains accessible.${failedCall ? ' A cleanup call failed; inspect the receipt.' : ''}`
}
