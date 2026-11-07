import { decodeBytes32String, getAddress, Interface, isHexString, ZeroAddress } from 'ethers'
import { CHAIN, CHAIN_ID, registerToken, tokenFor, tokenIdFor, type TokenSymbol } from './config'
import type { PrivateToken } from './networks'
import { readPrivateState, writePrivateState } from './storage'
import type { WalletSession } from './wallet'

const KEY = 'tokenCatalog:v1'
const MAX_TOKENS = 1024
const RPC_TIMEOUT = 10_000
const READ_GAS = 150_000n
const METADATA = new Interface(['function decimals() view returns (uint8)', 'function symbol() view returns (string)'])
const queues = new Map<string, Promise<void>>()

async function serialized<T>(session: WalletSession, operation: () => Promise<T>): Promise<T> {
  const scope = `${CHAIN_ID}:${session.info.id}`
  const task = (queues.get(scope) ?? Promise.resolve()).then(operation)
  const tail = task.then(() => {}, () => {})
  queues.set(scope, tail)
  try { return await task } finally { if (queues.get(scope) === tail) queues.delete(scope) }
}

async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Token metadata request timed out. Try again.')), RPC_TIMEOUT)
    })])
  } finally { clearTimeout(timer) }
}

function validSymbol(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 64 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

function checkedToken(value: unknown): PrivateToken {
  if (!value || typeof value !== 'object' || !('address' in value) || typeof value.address !== 'string' ||
    !('decimals' in value) || typeof value.decimals !== 'number' || !Number.isInteger(value.decimals) ||
    value.decimals < 0 || value.decimals > 77 || !('symbol' in value) || !validSymbol(value.symbol))
    throw new Error('Saved private token metadata is invalid. Keep your wallet data and retry after repair.')
  const address = getAddress(value.address)
  if (address === ZeroAddress) throw new Error('A token contract address is required.')
  const existing = tokenIdFor(address)
  if (existing && tokenFor(existing).decimals !== value.decimals)
    throw new Error('Token decimals changed. Review this asset before spending.')
  return { address, decimals: value.decimals, symbol: value.symbol.trim() }
}

async function catalog(session: WalletSession): Promise<PrivateToken[]> {
  const value = await readPrivateState(session, KEY)
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
    !('chainId' in value) || value.chainId !== CHAIN_ID || !('tokens' in value) ||
    !Array.isArray(value.tokens) || value.tokens.length > MAX_TOKENS)
    throw new Error('Saved private token catalog is invalid for this network.')
  const tokens = value.tokens.map(checkedToken)
  if (new Set(tokens.map(token => token.address)).size !== tokens.length)
    throw new Error('Saved private token catalog contains duplicate addresses.')
  return tokens
}

export function loadTokenCatalog(session: WalletSession): Promise<void> {
  return serialized(session, async () => {
    // Validate the entire decrypted record before changing the runtime registry.
    const tokens = await catalog(session)
    tokens.forEach(token => registerToken(token))
  })
}

async function symbol(session: WalletSession, address: string, blockTag: number): Promise<string> {
  try {
    const raw = await bounded(session.provider.call({ to: address, data: METADATA.encodeFunctionData('symbol'),
      gasLimit: READ_GAS, blockTag }))
    if (!isHexString(raw) || raw.length > 2 + 512 * 2) throw new Error('Invalid token symbol encoding.')
    const value = isHexString(raw, 32) ? decodeBytes32String(raw) : METADATA.decodeFunctionResult('symbol', raw)[0]
    if (validSymbol(value)) return value.trim()
  } catch { /* ERC-20 metadata is optional; an address label never substitutes a token identity. */ }
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/** Metadata and interface probes do not certify transfer behaviour or RAILGUN compatibility. */
export function importPrivateToken(session: WalletSession, input: string): Promise<TokenSymbol> {
  return serialized(session, async () => {
    const address = getAddress(input)
    if (address === ZeroAddress) throw new Error('A token contract address is required.')
    const tokens = await catalog(session)
    if ((await bounded(session.provider.getNetwork())).chainId !== CHAIN)
      throw new Error('Token import requires the selected private network.')
    const blockTag = await bounded(session.provider.getBlockNumber())
    const code = await bounded(session.provider.getCode(address, blockTag))
    if (!isHexString(code) || code === '0x') throw new Error('No token contract exists at this address on this network.')
    const [rawDecimals, label] = await Promise.all([
      bounded(session.provider.call({ to: address, data: METADATA.encodeFunctionData('decimals'), gasLimit: READ_GAS, blockTag })),
      symbol(session, address, blockTag),
    ])
    if (!isHexString(rawDecimals, 32)) throw new Error('Token decimals could not be verified.')
    const decimals = BigInt(rawDecimals)
    // Ethers accepts up to80; this integration deliberately bounds amount formatting to77.
    if (decimals > 77n) throw new Error('Token decimals must be from 0 to 77.')
    if ((await bounded(session.provider.getNetwork())).chainId !== CHAIN)
      throw new Error('Token import requires the selected private network.')
    const existing = tokenIdFor(address)
    const saved = tokens.find(token => token.address === address)
    const prior = existing ? tokenFor(existing) : saved
    if (prior && prior.decimals !== Number(decimals))
      throw new Error('Token decimals changed. Review this asset before spending.')
    const token = checkedToken(prior ?? { address, decimals: Number(decimals), symbol: label })
    if (!saved) {
      if (tokens.length >= MAX_TOKENS) throw new Error('Private token catalog has reached its supported size.')
      // This key uses the existing encrypted wallet/chain storage path; never a preference/localStorage key.
      await writePrivateState(session, KEY, { version: 1, chainId: CHAIN_ID, tokens: [...tokens, token] })
    }
    return registerToken(token)
  })
}
