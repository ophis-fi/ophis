import { useAtomValue } from 'jotai'
import { ReactNode, useMemo } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { listsStatesMapAtom } from '@cowprotocol/tokens'

import { Trans } from '@lingui/react/macro'

import { coinbaseStockAssetsQueryAtom } from './CoinbaseStockContext.atoms'
import * as styledEl from './CoinbaseStockContext.styled'
import {
  BASE_CHAIN_ID,
  COINBASE_TOKENIZED_STOCKS_DOCS,
  formatMultiplierLabel,
  isCoinbaseStockAddress,
  isInLoadedCoinbaseList,
  isUnitMultiplier,
  needsAttention,
  scaleByMultiplier,
  selectStockAssets,
} from './data'

const COINBASE_MARK = <styledEl.Mark aria-hidden="true">B20</styledEl.Mark>

function baseToken(currency: Currency | null): Currency | null {
  return currency?.isToken && currency.chainId === BASE_CHAIN_ID ? currency : null
}

function tokenAddress(currency: Currency | null): string | undefined {
  const token = baseToken(currency)
  return token?.isToken ? token.address : undefined
}

function shareEquivalent(balance: CurrencyAmount<Currency> | null, multiplier: string): string | undefined {
  if (!balance || balance.currency.chainId !== BASE_CHAIN_ID || isUnitMultiplier(multiplier)) return undefined
  const shareRaw = scaleByMultiplier(BigInt(balance.quotient.toString()), multiplier)
  return CurrencyAmount.fromRawAmount(balance.currency, shareRaw.toString()).toSignificant(6)
}

function EligibilityNote(): ReactNode {
  return (
    <Trans>
      Coinbase tokenized stocks are only available to persons in eligible jurisdictions outside the U.S. This panel is
      informational and does not change your order.{' '}
      <a href={COINBASE_TOKENIZED_STOCKS_DOCS} target="_blank" rel="noopener noreferrer">
        How B20 stocks work ↗
      </a>
    </Trans>
  )
}

export interface CoinbaseStockContextProps {
  chainId: number | undefined
  sellToken: Currency | null
  buyToken: Currency | null
  sellBalance: CurrencyAmount<Currency> | null
}

interface ContentProps extends Omit<CoinbaseStockContextProps, 'chainId'> {
  /** Symbols of the pair's Coinbase stocks, known from the token list before any metadata loads. */
  listedSymbols: string
}

function CoinbaseStockContextContent({ sellToken, buyToken, sellBalance, listedSymbols }: ContentProps): ReactNode {
  const { data: assets = [], isError, isPending } = useAtomValue(coinbaseStockAssetsQueryAtom)
  const sellAddress = tokenAddress(sellToken)
  const buyAddress = tokenAddress(buyToken)
  const selectedAssets = useMemo(
    () => selectStockAssets(assets, sellAddress, buyAddress),
    [assets, sellAddress, buyAddress],
  )

  // Any query error, including a failed background refetch that leaves cached `assets` in
  // place, means the multiplier / pause values on screen can no longer be called current.
  // Say so instead of presenting retained data as verified (Codex P2 on PR #1237).
  if (isError) {
    return (
      <styledEl.Panel $attention>
        {COINBASE_MARK}
        <styledEl.Content>
          <strong>
            <Trans>{listedSymbols} · Coinbase tokenized stock metadata is temporarily unavailable</Trans>
          </strong>
          <p>
            <Trans>
              Ophis could not verify the corporate-action multiplier or transfer status. Quotes remain available, but
              confirm the token status before trading.
            </Trans>{' '}
            <EligibilityNote />
          </p>
        </styledEl.Content>
      </styledEl.Panel>
    )
  }

  // Membership is already known from the token list, so the panel occupies its slot from the
  // first paint (no layout jump when the metadata query lands) and simply fills in the details.
  if (selectedAssets.length === 0) {
    return (
      <styledEl.Panel $attention={false}>
        {COINBASE_MARK}
        <styledEl.Content>
          <strong>
            <Trans>{listedSymbols} · Coinbase tokenized stock on Base</Trans>
          </strong>
          <p>
            <Trans>Coinbase B20 token backed by the underlying share held in regulated custody.</Trans>{' '}
            {isPending ? <Trans>Reading the corporate-action multiplier from Base.</Trans> : null} <EligibilityNote />
          </p>
        </styledEl.Content>
      </styledEl.Panel>
    )
  }

  const attention = selectedAssets.some(needsAttention)
  const selectedSymbols = selectedAssets.map((asset) => asset.symbol).join(', ')
  const pausedSymbols = selectedAssets
    .filter((asset) => asset.transfersPaused)
    .map((asset) => asset.symbol)
    .join(', ')
  const unissuedSymbols = selectedAssets
    .filter((asset) => !asset.issued)
    .map((asset) => asset.symbol)
    .join(', ')

  return (
    <styledEl.Panel $attention={attention}>
      {COINBASE_MARK}
      <styledEl.Content>
        <strong>
          <Trans>{selectedSymbols} · Coinbase tokenized stock on Base</Trans>
          {pausedSymbols ? <Trans> · transfers paused for {pausedSymbols}</Trans> : null}
          {unissuedSymbols ? <Trans> · {unissuedSymbols} not issued yet</Trans> : null}
        </strong>
        <p>
          <Trans>
            Coinbase B20 token backed by the underlying share held in regulated custody; multiplier and pause status
            read from the Base contracts.
          </Trans>
          {selectedAssets.map((asset) => {
            const symbol = asset.symbol
            const multiplier = formatMultiplierLabel(asset.multiplier)
            const selectedIsSell = areAddressesEqual(sellAddress, asset.address)
            const equivalent = selectedIsSell ? shareEquivalent(sellBalance, asset.multiplier) : undefined

            return (
              <styledEl.AssetDetail key={asset.address}>
                <Trans>
                  {symbol}: corporate-action multiplier {multiplier}×.
                </Trans>
                {equivalent ? (
                  <Trans> Your displayed balance represents about {equivalent} underlying shares.</Trans>
                ) : null}
                {!asset.issued ? (
                  <Trans> Coinbase has not minted supply yet, so quotes return no liquidity until it does.</Trans>
                ) : null}
              </styledEl.AssetDetail>
            )
          })}
          <EligibilityNote />
        </p>
      </styledEl.Content>
    </styledEl.Panel>
  )
}

export function CoinbaseStockContext({
  chainId,
  sellToken,
  buyToken,
  sellBalance,
}: CoinbaseStockContextProps): ReactNode {
  const sellStock = baseToken(sellToken)
  const buyStock = baseToken(buyToken)
  const listStates = useAtomValue(listsStatesMapAtom)
  // Membership = the bundled list (holds however the token entered the pair: curated-only
  // mode, bridge output, pasted address) OR the official list as currently loaded (catches a
  // stock added by a deployment newer than this bundle).
  const sellAddress = tokenAddress(sellStock)
  const buyAddress = tokenAddress(buyStock)
  const sellIsStock =
    isCoinbaseStockAddress(sellStock?.chainId, sellAddress) ||
    isInLoadedCoinbaseList(listStates, sellStock?.chainId, sellAddress)
  const buyIsStock =
    isCoinbaseStockAddress(buyStock?.chainId, buyAddress) ||
    isInLoadedCoinbaseList(listStates, buyStock?.chainId, buyAddress)
  const onBase =
    chainId === BASE_CHAIN_ID || sellToken?.chainId === BASE_CHAIN_ID || buyToken?.chainId === BASE_CHAIN_ID

  if (!onBase || (!sellIsStock && !buyIsStock)) return null

  const listedSymbols = [sellIsStock ? sellStock?.symbol : undefined, buyIsStock ? buyStock?.symbol : undefined]
    .filter((symbol, index, all): symbol is string => Boolean(symbol) && all.indexOf(symbol) === index)
    .join(', ')

  // The panel (and its metadata query) only exists while a Coinbase stock is actually in the
  // pair, never for every Base swap.
  return (
    <CoinbaseStockContextContent
      sellToken={sellToken}
      buyToken={buyToken}
      sellBalance={sellBalance}
      listedSymbols={listedSymbols}
    />
  )
}
