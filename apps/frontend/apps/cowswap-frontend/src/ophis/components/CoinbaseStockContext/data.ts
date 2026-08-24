import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'
import { COINBASE_TOKENIZED_STOCKS_LIST_SOURCE } from '@cowprotocol/tokens'

import shippedList from '../../../../public/token-lists/coinbase-tokenized-stocks.json'

import type { CoinbaseStockAsset, CoinbaseStockAssetsResponse } from './types'

export const BASE_CHAIN_ID = 8453
export const COINBASE_TOKENIZED_STOCKS_DOCS = 'https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base'

// The same file that is served at /token-lists/ for the selector, bundled so membership does
// not depend on which token lists a visitor currently has loaded (curated-only mode for U.S.
// visitors, a bridge whose source chain is not Base, a pasted address): the eligibility panel
// must reach exactly those visitors too.
const COINBASE_STOCK_ADDRESS_KEYS: ReadonlySet<string> = new Set(
  shippedList.tokens.filter((token) => token.chainId === BASE_CHAIN_ID).map((token) => getAddressKey(token.address)),
)

export function isCoinbaseStockAddress(chainId: number | undefined, address: string | undefined): boolean {
  return chainId === BASE_CHAIN_ID && !!address && COINBASE_STOCK_ADDRESS_KEYS.has(getAddressKey(address))
}

interface LoadedListLike {
  source?: string
  list: { tokens: ReadonlyArray<{ chainId: number; address: string }> }
}

/**
 * Membership according to the official Coinbase list as currently LOADED (it refreshes at
 * runtime), so a stock added by a later deployment is recognised in a tab whose bundle predates
 * it. Only the configured official source counts; any other list carrying the address does not.
 */
export function isInLoadedCoinbaseList(
  listStates: Readonly<Record<string, LoadedListLike | undefined>>,
  chainId: number | undefined,
  address: string | undefined,
): boolean {
  if (chainId !== BASE_CHAIN_ID || !address) return false
  const tokens = listStates[COINBASE_TOKENIZED_STOCKS_LIST_SOURCE]?.list.tokens ?? []

  return tokens.some((token) => token.chainId === BASE_CHAIN_ID && areAddressesEqual(token.address, address))
}

const ONE_18 = 10n ** 18n
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const MULTIPLIER_RE = /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/
const MAX_TEXT_LENGTH = 100
const MAX_ASSETS = 64

export function findCoinbaseStockAsset(
  assets: readonly CoinbaseStockAsset[],
  address: string | undefined,
): CoinbaseStockAsset | undefined {
  if (!address) return undefined

  return assets.find((asset) => areAddressesEqual(asset.address, address))
}

function multiplierToWad(multiplier: string): bigint {
  const [whole = '0', fraction = ''] = multiplier.split('.')
  return BigInt(whole) * ONE_18 + BigInt(fraction.padEnd(18, '0').slice(0, 18))
}

export function isUnitMultiplier(multiplier: string): boolean {
  return multiplierToWad(multiplier) === ONE_18
}

/** rawAmount × multiplier, in the token's own raw units (multiplier is WAD-precision). */
export function scaleByMultiplier(rawAmount: bigint, multiplier: string): bigint {
  return (rawAmount * multiplierToWad(multiplier)) / ONE_18
}

/** Stock assets on either side of the pair, sell side first, without duplicates. */
export function selectStockAssets(
  assets: readonly CoinbaseStockAsset[],
  sellAddress: string | undefined,
  buyAddress: string | undefined,
): CoinbaseStockAsset[] {
  const selected: CoinbaseStockAsset[] = []
  for (const address of [sellAddress, buyAddress]) {
    const asset = findCoinbaseStockAsset(assets, address)
    if (asset && !selected.includes(asset)) selected.push(asset)
  }
  return selected
}

/** "1.020000000000000000" -> "1.02", capped at 6 fractional digits for display. */
export function formatMultiplierLabel(multiplier: string): string {
  const wad = multiplierToWad(multiplier)
  const rounded = (wad * 1_000_000n + ONE_18 / 2n) / ONE_18
  const whole = rounded / 1_000_000n
  const digits = (rounded % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return digits ? `${whole}.${digits}` : `${whole}`
}

export function needsAttention(asset: CoinbaseStockAsset): boolean {
  return asset.transfersPaused || !asset.issued || !isUnitMultiplier(asset.multiplier)
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH && !/[<>]/.test(value)
}

function isAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value)
}

function isMultiplier(value: unknown): value is string {
  return typeof value === 'string' && MULTIPLIER_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStockAsset(asset: Record<string, unknown>): asset is Record<string, unknown> & CoinbaseStockAsset {
  const identityOk = isAddress(asset.address) && boundedText(asset.symbol) && boundedText(asset.name)
  const stateOk =
    isMultiplier(asset.multiplier) && typeof asset.issued === 'boolean' && typeof asset.transfersPaused === 'boolean'

  return identityOk && stateOk
}

function parseAsset(value: unknown): CoinbaseStockAsset {
  if (!isRecord(value) || !isStockAsset(value)) throw new Error('Malformed stock asset')

  return {
    address: value.address,
    symbol: value.symbol,
    name: value.name,
    multiplier: value.multiplier,
    issued: value.issued,
    transfersPaused: value.transfersPaused,
  }
}

export function parseCoinbaseStockAssets(payload: unknown): CoinbaseStockAsset[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Malformed stock payload')
  const response = payload as Partial<CoinbaseStockAssetsResponse>
  if (response.chainId !== BASE_CHAIN_ID || !Array.isArray(response.assets) || response.assets.length > MAX_ASSETS) {
    throw new Error('Malformed stock payload')
  }

  return response.assets.map(parseAsset)
}

export async function fetchCoinbaseStockAssets(): Promise<CoinbaseStockAsset[]> {
  // Same-origin Pages Function: reads the shipped token list and batches the B20 views on
  // Base once per edge cache window instead of every browser hitting an RPC.
  const response = await fetch('/api/base/tokenized-stocks')
  if (!response.ok) throw new Error(`Coinbase tokenized stock API returned ${response.status}`)

  return parseCoinbaseStockAssets(await response.json())
}
