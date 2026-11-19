// The chain module: JSON-RPC over fetch to the two endpoints of a chain, the one verifier of a wallet signature
// (EIP-712 digest, key recovery, then ERC-1271), the Safe reads, and the colour of a recovery wallet.
// A contract wallet's answer counts only when both endpoints, each of which first says it is the pinned chain,
// give the same one. An error, a redirect, a timeout, an answer that is too large or a disagreement is a refusal.
import { decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, isAddress, isAddressEqual, keccak256, parseAbi, recoverAddress, toHex, type Hex } from 'viem'
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

// The official Safe contracts, from the package @safe-global/safe-deployments 1.37.67 (dist/assets/v1.3.0, v1.4.1 and
// v1.5.0: proxy factory, Safe and SafeL2 singletons, CompatibilityFallbackHandler). Each flavour is listed there on
// chains 1, 10, 8453 and 42161, and 4663 and 5042 (code byte-identical to Ethereum's on both endpoints, 2026-11-19). proxy: keccak256 of the runtime code of the proxy that the flavour's factory creates,
// read on a fork. tests/chain.mjs creates a Safe through every factory here and proves each line of this table.
export const SAFES = [
  { version: '1.3.0', factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2', singletons: ['0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', '0x3E5c63644E683549055b9Be8653de26E0B4CD36E'], handler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4', proxy: '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000' },
  { version: '1.3.0 eip155', factory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC', singletons: ['0x69f4D1788e39c87893C980c06EdF4b7f686e2938', '0xfb1bffC9d739B8D520DaF37dF666da4C687191EA'], handler: '0x017062a1dE2FE6b99BE3d9d37841FeD19F573804', proxy: '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000' },
  { version: '1.4.1', factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', singletons: ['0x41675C099F32341bf84BFc5382aF534df5C7461a', '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'], handler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99', proxy: '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c' },
  { version: '1.5.0', factory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b', singletons: ['0xFf51A5898e281Db6DfC7855790607438dF2ca44b', '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e'], handler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4', proxy: '0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f' },
] as const
const HANDLER_SLOT = keccak256(toHex('fallback_manager.handler.address')) // where a Safe keeps its fallback handler
const inSlot = (word: string) => `0x${word.slice(26)}` // the address in a 32-byte storage word, lower case

/** The bytes of a body, or null once it passes `max` bytes. readCapped: the same as text. */
export async function readBytes(body: ReadableStream<Uint8Array> | null, max: number) {
  const reader = body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = (await reader?.read()) ?? { done: true }
    if (done || !value) break
    size += value.byteLength
    if (size > max) {
      await reader!.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.byteLength), 0)
  return bytes
}
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number) {
  const bytes = await readBytes(body, max)
  return bytes && new TextDecoder().decode(bytes)
}

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(LIMITS.timeoutMs),
    redirect: 'manual', // not followed: each hop would be one more subrequest of the 50, and a 3xx is no answer below
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const text = response.ok ? await readCapped(response.body, LIMITS.maxBytes) : null
  const result = text === null ? null : (JSON.parse(text) as { result?: unknown }).result
  if (typeof result !== 'string') throw new Error('rpc') // not hex: no caller can decode it or match it, so it counts as no answer
  return lower(result)
}

/** The same list of reads on both endpoints: an eth_call (its data), or another method with its parameters. Per read: the answer both gave, or null. An endpoint on another chain answers nothing. */
export async function reads(endpoints: Endpoints, chainId: number, to: string, calls: (Hex | [method: string, ...params: unknown[]])[]) {
  const sides = await Promise.all(endpoints.map(async (url) => {
    try {
      if (BigInt(await rpc(url, 'eth_chainId', [])) !== BigInt(chainId)) return null
      return await Promise.all(calls.map((call) => (typeof call === 'string' ? rpc(url, 'eth_call', [{ to, data: call }, 'latest']) : rpc(url, call[0], call.slice(1))).catch(() => null)))
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
export const verify = (endpoints: Endpoints, typed: Typed, wallet: string, signature: Hex) => verifyDigest(endpoints, typed.domain.chainId, hashTypedData(typed as never), wallet, signature)
/** The same for a digest the server built and stored earlier: a recovery proof is checked again when it is used. */
export async function verifyDigest(endpoints: Endpoints, chainId: number, digest: Hex, wallet: string, signature: Hex) {
  // Recovery first, never a look at the code size: an account with an EIP-7702 delegation has code and signs with its key.
  if (await signedByKey(digest, wallet, signature)) return { by: 'key' as const, digest }
  const [answer] = await reads(endpoints, chainId, wallet, [encodeFunctionData({ abi: ABI, functionName: 'isValidSignature', args: [digest, signature] })])
  return answer === MAGIC ? { by: 'contract' as const, digest } : null
}

/**
 * Did the wallet's own key sign this digest? 65 bytes that recover to the wallet; the upper half of s is refused, so
 * each signature has one accepted form. No endpoint is asked: a key controls its address on every chain, a contract
 * only on the chain it was asked on.
 */
export async function signedByKey(digest: Hex, wallet: string, signature: Hex) {
  if (signature.length !== 132 || BigInt(`0x${signature.slice(66, 130)}`) > HALF_N) return false
  const signer = await recoverAddress({ hash: digest, signature }).catch(() => null)
  return Boolean(signer && isAddressEqual(signer, wallet as Hex))
}

// Multicall3, at the same address on every chain of the desk (tests/chain.mjs reads its code on each fork).
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const BALANCES = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) view returns (Result[] returnData)', 'function balanceOf(address owner) view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
])
/** ETH itself, where a token address is asked for: the marker the settlement pays ETH out to (GPv2 BUY_ETH_ADDRESS). */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/**
 * ERC-20 balances, one aggregate3 eth_call for every [wallet, token] pair of one chain, as both endpoints see it; for
 * NATIVE, the wallet's ETH (Multicall3's own getEthBalance). Per pair: the balance, or null when that call failed. Null:
 * no answer both endpoints gave.
 */
export async function balancesOf(endpoints: Endpoints, chainId: number, pairs: [wallet: string, token: string][]) {
  const calls = pairs.map(([wallet, token]) => (token === NATIVE
    ? { target: MULTICALL3 as Hex, allowFailure: true, callData: encodeFunctionData({ abi: BALANCES, functionName: 'getEthBalance', args: [wallet as Hex] }) }
    : { target: token as Hex, allowFailure: true, callData: encodeFunctionData({ abi: BALANCES, functionName: 'balanceOf', args: [wallet as Hex] }) }))
  const [answer] = await reads(endpoints, chainId, MULTICALL3, [encodeFunctionData({ abi: BALANCES, functionName: 'aggregate3', args: [calls] })])
  try {
    const results = decodeFunctionResult({ abi: BALANCES, functionName: 'aggregate3', data: answer! })
    if (results.length !== pairs.length) return null
    return results.map((r) => (r.success && r.returnData.length === 66 ? BigInt(r.returnData) : null))
  } catch {
    return null
  }
}

export interface SafeState { owners: string[]; threshold: number; modules: string[]; handler: boolean }
/**
 * Owners, threshold and modules of a genuine Safe, as both endpoints see it. Genuine: the runtime code is an official
 * Safe proxy's and storage slot 0 holds an official Safe or SafeL2 singleton (SAFES). Null otherwise: a contract that
 * only answers like a Safe is not one, and nothing it says about its owners is kept or shown.
 * handler: the fallback handler slot holds the official CompatibilityFallbackHandler of the singleton's version, which
 * is the code that answers isValidSignature. threshold: 0 unless 1 <= threshold <= number of owners, compared as bigint.
 */
export async function safeState(endpoints: Endpoints, chainId: number, wallet: string): Promise<SafeState | null> {
  // ponytail: the first 10 modules. One is enough to lose green; a longer list is not shown in full.
  const [code, master, handler, threshold, owners, modules] = await reads(endpoints, chainId, wallet, [
    ['eth_getCode', wallet, 'latest'], ['eth_getStorageAt', wallet, '0x0', 'latest'], ['eth_getStorageAt', wallet, HANDLER_SLOT, 'latest'],
    encodeFunctionData({ abi: ABI, functionName: 'getThreshold' }), encodeFunctionData({ abi: ABI, functionName: 'getOwners' }),
    encodeFunctionData({ abi: ABI, functionName: 'getModulesPaginated', args: ['0x0000000000000000000000000000000000000001', 10n] }),
  ])
  try {
    const official = SAFES.find((safe) => safe.singletons.some((singleton) => lower(singleton) === inSlot(master!)))
    if (!official || !SAFES.some((safe) => safe.proxy === keccak256(code!))) return null
    const signers = decodeFunctionResult({ abi: ABI, functionName: 'getOwners', data: owners! }).map(lower).sort()
    const needed = decodeFunctionResult({ abi: ABI, functionName: 'getThreshold', data: threshold! })
    return {
      threshold: needed >= 1n && needed <= BigInt(signers.length) ? Number(needed) : 0, owners: signers,
      modules: decodeFunctionResult({ abi: ABI, functionName: 'getModulesPaginated', data: modules! })[0].map(lower).sort(),
      handler: inSlot(handler!) === lower(official.handler),
    }
  } catch {
    return null
  }
}

/**
 * The colour of a recovery wallet. Green: a genuine Safe, in force, read on both endpoints now, the official fallback
 * handler, threshold 2 or more, no module, owners and threshold as in the snapshot taken at its approval. Anything
 * else is amber, with the reason.
 */
export function colour(wallet: { kind: string; snapshot: string | null; inForce: boolean }, live: SafeState | null) {
  const seen = wallet.snapshot ? (JSON.parse(wallet.snapshot) as SafeState) : null
  const why = !wallet.inForce ? 'waiting' // first: until its 72 hours pass it does not count, whatever it is
    : wallet.kind !== 'safe' ? wallet.kind
    : !live ? 'unreadable'
    : !live.handler ? 'handler'
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
