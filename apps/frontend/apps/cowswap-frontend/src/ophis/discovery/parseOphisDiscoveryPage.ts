import { getAddressKey } from '@cowprotocol/cow-sdk'

import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'

import { OPHIS_DISCOVERY_EXCLUDED_ADDRESSES, OPHIS_DISCOVERY_MAX_RESULTS } from './ophisDiscovery.const'

import type { OphisDiscoveredToken } from './ophisDiscovery.types'

const EVM_KIND = 0
const ERC20_STANDARD = 2
const MAX_DECIMALS = 36
const MAX_NAME_LENGTH = 40
const MAX_SYMBOL_LENGTH = 12
const MAX_UINT32 = 4_294_967_295
const EVM_ACCOUNT_PREFIX = /^0x0{24}/i
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/i

const EXCLUDED_ADDRESS_KEYS = new Set(OPHIS_DISCOVERY_EXCLUDED_ADDRESSES.map(getAddressKey))

function isBlockedCodePoint(value: number): boolean {
  return (
    value <= 0x1f ||
    (value >= 0x7f && value <= 0x9f) ||
    (value >= 0x200b && value <= 0x200f) ||
    (value >= 0x202a && value <= 0x202e) ||
    (value >= 0x2066 && value <= 0x2069)
  )
}

function sanitizeLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null

  const safeCharacters = Array.from(value.normalize('NFKC')).filter((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && !isBlockedCodePoint(codePoint) && character !== '<' && character !== '>'
  })
  const normalized = safeCharacters.join('').replace(/\s+/g, ' ').trim()
  if (!normalized) return null

  return Array.from(normalized).slice(0, maxLength).join('')
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function accountToAddress(value: unknown): Address | null {
  if (typeof value !== 'string' || !BYTES32_PATTERN.test(value) || !EVM_ACCOUNT_PREFIX.test(value)) return null

  try {
    return getAddress(`0x${value.slice(-40)}`)
  } catch {
    return null
  }
}

interface RawSummary {
  id: unknown
  account: unknown
  chainId: unknown
  decimals: unknown
  kind: unknown
  standard: unknown
  deployed: unknown
  synced: unknown
  rank: unknown
  name: unknown
  symbol: unknown
}

function asRawSummary(value: unknown): RawSummary | null {
  if (Array.isArray(value)) {
    if (value.length !== 14) return null
    return {
      id: value[0],
      account: value[1],
      chainId: value[2],
      decimals: value[3],
      kind: value[4],
      standard: value[5],
      deployed: value[6],
      synced: value[8],
      rank: value[10],
      name: value[12],
      symbol: value[13],
    }
  }

  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  return {
    id: record.id,
    account: record.account,
    chainId: record.chainId,
    decimals: record.decimals,
    kind: record.kind,
    standard: record.standard,
    deployed: record.deployed,
    synced: record.synced,
    rank: record.rank,
    name: record.name,
    symbol: record.symbol,
  }
}

function hasSupportedClassification(raw: RawSummary, expectedChainId: 1): boolean {
  return (
    raw.chainId === BigInt(expectedChainId) &&
    raw.kind === EVM_KIND &&
    raw.standard === ERC20_STANDARD &&
    raw.deployed === true &&
    raw.synced === true
  )
}

function hasSupportedNumbers(raw: RawSummary): raw is RawSummary & { decimals: number; rank: number } {
  return isBoundedInteger(raw.decimals, 0, MAX_DECIMALS) && isBoundedInteger(raw.rank, 0, MAX_UINT32)
}

function isAllowedAddress(value: Address | null): value is Address {
  return value !== null && !isAddressEqual(value, zeroAddress) && !EXCLUDED_ADDRESS_KEYS.has(getAddressKey(value))
}

function parseRow(value: unknown, expectedChainId: 1): OphisDiscoveredToken | null {
  const raw = asRawSummary(value)
  if (!raw) return null
  if (typeof raw.id !== 'bigint' || raw.id < 0n) return null
  if (!hasSupportedClassification(raw, expectedChainId) || !hasSupportedNumbers(raw)) return null

  const address = accountToAddress(raw.account)
  if (!isAllowedAddress(address)) return null

  const safeName = sanitizeLabel(raw.name, MAX_NAME_LENGTH)
  const safeSymbol = sanitizeLabel(raw.symbol, MAX_SYMBOL_LENGTH)
  if (!safeName || !safeSymbol) return null

  return {
    id: raw.id.toString(),
    address,
    chainId: expectedChainId,
    decimals: raw.decimals,
    name: safeName,
    symbol: safeSymbol,
    rank: raw.rank,
  }
}

export function parseOphisDiscoveryPage(value: unknown, expectedChainId: 1): OphisDiscoveredToken[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const result: OphisDiscoveredToken[] = []

  for (const rawRow of value) {
    if (result.length >= OPHIS_DISCOVERY_MAX_RESULTS) break

    const token = parseRow(rawRow, expectedChainId)
    if (!token) continue

    const key = `${token.chainId}:${getAddressKey(token.address)}`
    if (seen.has(key)) continue

    seen.add(key)
    result.push(token)
  }

  return result
}

export function isNonEmptyCode(value: Hex | undefined): value is Hex {
  return value !== undefined && value !== '0x'
}
