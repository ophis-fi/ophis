// The chain module: JSON-RPC over fetch to the two endpoints of a chain, the one verifier of a wallet signature
// (EIP-712 digest, key recovery, then ERC-1271), the Safe reads, and the colour of a recovery wallet.
// A contract wallet's answer counts only when both endpoints, each of which first says it is the pinned chain,
// give the same one. An error, a timeout, an answer that is too large or a disagreement is a refusal.
import { decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, isAddress, isAddressEqual, parseAbi, recoverAddress, type Hex } from 'viem'
import type { Typed } from './typed.ts'

export type Endpoints = readonly [string, string]
/** Tests lower these. */
export const LIMITS = { timeoutMs: 5000, maxBytes: 16 * 1024 }
const ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
])
const MAGIC = `0x1626ba7e${'0'.repeat(56)}` // ERC-1271, as a 32-byte word
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n // secp256k1: half the group order
const lower = (address: string) => address.toLowerCase()

/** The text of a body, or null once it passes `max` bytes. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number) {
  const reader = body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(LIMITS.timeoutMs),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = response.ok ? await readCapped(response.body, LIMITS.maxBytes) : null
  const result = text === null ? null : (JSON.parse(text) as { result?: unknown }).result
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('rpc')
  return lower(result)
}

/** The same eth_call list on both endpoints. Per call: the answer both gave, or null. An endpoint on another chain answers nothing. */
export async function reads(endpoints: Endpoints, chainId: number, to: string, calls: Hex[]) {
  const sides = await Promise.all(endpoints.map(async (url) => {
    try {
      if (BigInt(await rpc(url, 'eth_chainId', [])) !== BigInt(chainId)) return null
      return await Promise.all(calls.map((data) => rpc(url, 'eth_call', [{ to, data }, 'latest']).catch(() => null)))
    } catch {
      return null
    }
  }))
  return calls.map((_, i) => (sides[0]?.[i] != null && sides[0][i] === sides[1]?.[i] ? (sides[0][i] as Hex) : null))
}

/**
 * Is `signature` the wallet's signature of this typed data? The caller builds `typed` from fields the server holds.
 * 'key': 65 bytes that recover to the wallet; no endpoint is asked. 'contract': isValidSignature(digest, signature)
 * returned the ERC-1271 value on both endpoints ('0x' is a Safe message signed onchain). Null: refused.
 */
export async function verify(endpoints: Endpoints, typed: Typed, wallet: string, signature: Hex) {
  const digest = hashTypedData(typed as never)
  // Recovery first, never a look at the code size: an account with an EIP-7702 delegation has code and signs with its key.
  // The upper half of s is refused: each signature has one accepted form.
  if (signature.length === 132 && BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N) {
    const signer = await recoverAddress({ hash: digest, signature }).catch(() => null)
    if (signer && isAddressEqual(signer, wallet as Hex)) return { by: 'key' as const, digest }
  }
  const [answer] = await reads(endpoints, typed.domain.chainId, wallet, [encodeFunctionData({ abi: ABI, functionName: 'isValidSignature', args: [digest, signature] })])
  return answer === MAGIC ? { by: 'contract' as const, digest } : null
}

export interface SafeState { owners: string[]; threshold: number; modules: string[] }
/** Owners, threshold and modules, when the wallet answers all three as a Safe does on both endpoints. Null otherwise. */
export async function safeState(endpoints: Endpoints, chainId: number, wallet: string): Promise<SafeState | null> {
  // ponytail: the first 10 modules. One is enough to lose green; a longer list is not shown in full.
  const [threshold, owners, modules] = await reads(endpoints, chainId, wallet, [
    encodeFunctionData({ abi: ABI, functionName: 'getThreshold' }), encodeFunctionData({ abi: ABI, functionName: 'getOwners' }),
    encodeFunctionData({ abi: ABI, functionName: 'getModulesPaginated', args: ['0x0000000000000000000000000000000000000001', 10n] }),
  ])
  try {
    const state = {
      threshold: Number(decodeFunctionResult({ abi: ABI, functionName: 'getThreshold', data: threshold! })),
      owners: decodeFunctionResult({ abi: ABI, functionName: 'getOwners', data: owners! }).map(lower).sort(),
      modules: decodeFunctionResult({ abi: ABI, functionName: 'getModulesPaginated', data: modules! })[0].map(lower).sort(),
    }
    return state.threshold >= 1 && state.owners.length >= state.threshold ? state : null
  } catch {
    return null
  }
}

/**
 * The colour of a recovery wallet. Green: a Safe, in force, read on both endpoints now, threshold 2 or more, no
 * module, owners and threshold as in the snapshot taken at its approval. Anything else is amber, with the reason.
 */
export function colour(wallet: { kind: string; snapshot: string | null; inForce: boolean }, live: SafeState | null) {
  const seen = wallet.snapshot ? (JSON.parse(wallet.snapshot) as SafeState) : null
  const why = wallet.kind !== 'safe' ? wallet.kind
    : !wallet.inForce ? 'waiting'
    : !live ? 'unreadable'
    : live.modules.length > 0 ? 'module'
    : live.threshold < 2 ? 'threshold'
    : !seen || seen.threshold !== live.threshold || seen.owners.join() !== live.owners.join() ? 'changed'
    : null
  return { level: why ? ('amber' as const) : ('green' as const), why }
}

/** The address in lower case, as stored. Null: not an address, or mixed case with a wrong EIP-55 checksum. */
export const parseAddress = (value: unknown) => (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && isAddress(value) ? (lower(value) as Hex) : null)
/** EIP-55, for display and for the typed data. */
export const checksum = (address: string) => getAddress(address)
