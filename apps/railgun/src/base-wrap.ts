import { getAddress, hexlify, Interface, isHexString, randomBytes, ZeroAddress, type JsonRpcSigner } from 'ethers'
import { CHAIN, CHAIN_ID, WRAPPED_SYMBOL, tokenFor } from './config'
import { assertPublicNetwork, requireShieldBalance } from './shield'
import { readPrivateState, writePrivateState, deletePrivateState } from './storage'
import type { WalletSession } from './wallet'

const KEY = 'basePublicWrap'
const WETH = new Interface(['function deposit() payable', 'event Deposit(address indexed dst, uint256 wad)'])
const busy = new WeakSet<WalletSession>()
interface BaseWrap { version: 1; payer: string; nonce: number; amount: string; data: string; hash?: string; submittedNonce?: number; deferred?: true }

export async function baseWrapRecords(session: WalletSession): Promise<BaseWrap[]> {
  const value = await readPrivateState(session, KEY)
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4096) throw new Error('Invalid saved wraps. Preserve their recovery data.')
  const records = value as BaseWrap[]
  for (const saved of records) if (CHAIN_ID !== 8453 || !saved || saved.version !== 1 ||
    !Number.isSafeInteger(saved.nonce) || saved.nonce < 0 ||
    typeof saved.amount !== 'string' || !/^[1-9][0-9]{0,36}$/.test(saved.amount) || BigInt(saved.amount) >= 2n ** 120n ||
    !isHexString(saved.data, 36) || !saved.data.startsWith(WETH.encodeFunctionData('deposit')) ||
    getAddress(saved.payer) === ZeroAddress || (saved.hash !== undefined && !isHexString(saved.hash, 32)) ||
    (saved.submittedNonce !== undefined && (!saved.hash || !Number.isSafeInteger(saved.submittedNonce) || saved.submittedNonce < 0)) ||
    (saved.deferred !== undefined && saved.deferred !== true))
    throw new Error('Invalid saved wrap. Preserve its recovery data.')
  if (records.filter(record => !record.deferred).length > 1 || new Set(records.map(record => record.data)).size !== records.length)
    throw new Error('Saved wrap identities overlap. Preserve their recovery data.')
  return records
}

export async function savedBaseWrap(session: WalletSession): Promise<BaseWrap | undefined> {
  return (await baseWrapRecords(session)).find(record => !record.deferred)
}

async function saveRecords(session: WalletSession, records: BaseWrap[]): Promise<void> {
  if (records.length) await writePrivateState(session, KEY, records)
  else await deletePrivateState(session, KEY)
}

export async function deferBaseWrap(session: WalletSession): Promise<void> {
  if (busy.has(session)) throw new Error('A wrap is already in progress.')
  busy.add(session)
  try {
    const records = await baseWrapRecords(session)
    await saveRecords(session, records.map(record => ({ ...record, deferred: true })))
  } finally { busy.delete(session) }
}

/** Wrapping stays in the public wallet; no authorization or private execution account is involved. */
export async function wrapBaseNative(session: WalletSession, signer: JsonRpcSigner, amount: bigint,
  beforeSend: () => void = () => {}): Promise<string> {
  if (CHAIN_ID !== 8453 || (await session.provider.getNetwork()).chainId !== CHAIN)
    throw new Error('This wrap requires the selected Base network.')
  if (busy.has(session)) throw new Error('A wrap is already in progress.')
  busy.add(session)
  try {
    const previous = await baseWrapRecords(session)
    if (previous.some(record => !record.deferred)) throw new Error('Check the saved wrap before sending another.')
    if (previous.length >= 4096) throw new Error('Resolve saved wrap records before wrapping more.')
    await assertPublicNetwork(session, signer)
    await requireShieldBalance(signer, 'ETH', amount)
    const payer = getAddress(await signer.getAddress())
    const code = await session.provider.getCode(payer)
    if (code !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(code))
      throw new Error('Wrapping requires a direct transaction from your public wallet.')
    const record: BaseWrap = { version: 1, payer, amount: amount.toString(),
      nonce: await signer.provider.getTransactionCount(payer, 'pending'),
      // WETH9 ignores trailing ABI data; a unique intent survives wallets choosing their own nonce.
      data: WETH.encodeFunctionData('deposit') + hexlify(randomBytes(32)).slice(2) }
    await assertPublicNetwork(session, signer, beforeSend)
    await saveRecords(session, [...previous, record])
    try { beforeSend() } catch (error) { await saveRecords(session, previous); throw error }
    let sent
    try {
      sent = await signer.sendTransaction({ chainId: CHAIN, type: 2, nonce: record.nonce,
        to: tokenFor(WRAPPED_SYMBOL).address, data: record.data, value: amount })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error.code === 4001 || error.code === 'ACTION_REJECTED'))
        await saveRecords(session, [...previous, { ...record, deferred: true }])
      throw error
    }
    if (!isHexString(sent.hash, 32)) throw new Error('Wrap outcome unknown. Check its hash in your public wallet; do not wrap again.')
    await saveRecords(session, [...previous, { ...record, hash: sent.hash,
      ...(Number.isSafeInteger(sent.nonce) && sent.nonce >= 0 ? { submittedNonce: sent.nonce } : {}) }])
    return sent.hash
  } finally { busy.delete(session) }
}

export async function checkBaseWrap(session: WalletSession, suppliedHash?: string): Promise<{
  hash: string; amount: bigint; state: 'wrapped' | 'cancelled' | 'failed'
}> {
  if (busy.has(session)) throw new Error('A wrap is already in progress.')
  busy.add(session)
  try {
    const records = await baseWrapRecords(session), active = records.find(record => !record.deferred)
    if (!records.length) throw new Error('No wrap is saved.')
    if ((await session.provider.getNetwork()).chainId !== CHAIN) throw new Error('Wrap recovery requires Base.')
    const hash = suppliedHash || active?.hash
    if (!hash || !isHexString(hash, 32)) throw new Error('Copy the wrap, speed-up or cancellation hash from your public wallet.')
    const [tx, receipt, head] = await Promise.all([session.provider.getTransaction(hash),
      session.provider.getTransactionReceipt(hash), session.provider.getBlock('latest')])
    if (!tx || !receipt || !head || tx.hash.toLowerCase() !== hash.toLowerCase() || receipt.hash.toLowerCase() !== hash.toLowerCase() ||
      tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || head.number < receipt.blockNumber + 1 ||
      (await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
      throw new Error('The wrap needs two canonical confirmations. Keep its saved transaction.')
    const saved = records.find(record => record.data === tx.data) ?? records.find(record =>
      record.submittedNonce === tx.nonce && record.payer.toLowerCase() === tx.from.toLowerCase() &&
      tx.to?.toLowerCase() === record.payer.toLowerCase() && tx.data === '0x' && tx.value === 0n)
    if (!saved || ![0, 2].includes(tx.type) || tx.chainId !== CHAIN || getAddress(tx.from) !== getAddress(saved.payer) ||
      tx.authorizationList?.length || !tx.to || ![0, 1].includes(receipt.status ?? -1))
      throw new Error('This receipt does not match the saved wrap.')
    const cancelled = getAddress(tx.to) === getAddress(saved.payer) && tx.value === 0n && tx.data === '0x'
    const amount = BigInt(saved.amount), wrapped = getAddress(tokenFor(WRAPPED_SYMBOL).address)
    if (!cancelled && (getAddress(tx.to) !== wrapped || tx.value !== amount || tx.data !== saved.data))
      throw new Error('This receipt does not match the saved wrap amount or contract.')
    const state = receipt.status === 0 ? 'failed' : cancelled ? 'cancelled' : 'wrapped'
    if (state !== 'wrapped') {
      const finalized = await session.provider.getBlock('finalized')
      if (!finalized || finalized.number < receipt.blockNumber)
        throw new Error('Wait for the wrap failure or cancellation to finalize before wrapping again.')
    } else {
      const deposit = WETH.encodeEventLog(WETH.getEvent('Deposit')!, [saved.payer, amount])
      if (!receipt.logs.some(log => getAddress(log.address) === wrapped && log.data.toLowerCase() === deposit.data.toLowerCase() &&
        log.topics.length === deposit.topics.length && log.topics.every((topic, i) => topic.toLowerCase() === deposit.topics[i].toLowerCase())))
        throw new Error('The receipt does not contain the expected WETH deposit.')
    }
    if ((await session.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash)
      throw new Error('Wrap history changed. Keep its saved transaction and check again.')
    await saveRecords(session, records.filter(record => record.data !== saved.data))
    return { hash, amount, state }
  } finally { busy.delete(session) }
}
