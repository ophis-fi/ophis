import { useAtomValue } from 'jotai'
import { ReactNode, useMemo } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useIsCoinbaseStockToken } from '@cowprotocol/tokens'

import { Trans } from '@lingui/react/macro'

import { coinbaseStockAssetsQueryAtom } from './CoinbaseStockContext.atoms'
import * as styledEl from './CoinbaseStockContext.styled'
import {
  BASE_CHAIN_ID,
  COINBASE_TOKENIZED_STOCKS_DOCS,
  formatMultiplierLabel,
  isUnitMultiplier,
  needsAttention,
  scaleByMultiplier,
  selectStockAssets,
} from './data'

const COINBASE_MARK = <styledEl.Mark aria-hidden="true">B20</styledEl.Mark>

function tokenAddress(currency: Currency | null): string | undefined {
  return currency?.chainId === BASE_CHAIN_ID && currency.isToken ? currency.address : undefined
}

function shareEquivalent(balance: CurrencyAmount<Currency> | null, multiplier: string): string | undefined {
  if (!balance || balance.currency.chainId !== BASE_CHAIN_ID || isUnitMultiplier(multiplier)) return undefined
  const shareRaw = scaleByMultiplier(BigInt(balance.quotient.toString()), multiplier)
  return CurrencyAmount.fromRawAmount(balance.currency, shareRaw.toString()).toSignificant(6)
}

export interface CoinbaseStockContextProps {
  chainId: number | undefined
  sellToken: Currency | null
  buyToken: Currency | null
  sellBalance: CurrencyAmount<Currency> | null
}

function CoinbaseStockContextContent({
  sellToken,
  buyToken,
  sellBalance,
}: Omit<CoinbaseStockContextProps, 'chainId'>): ReactNode {
  const { data: assets = [], isError } = useAtomValue(coinbaseStockAssetsQueryAtom)
  const sellAddress = tokenAddress(sellToken)
  const buyAddress = tokenAddress(buyToken)
  const selectedAssets = useMemo(
    () => selectStockAssets(assets, sellAddress, buyAddress),
    [assets, sellAddress, buyAddress],
  )

  if (isError && assets.length === 0) {
    return (
      <styledEl.Panel $attention>
        {COINBASE_MARK}
        <styledEl.Content>
          <strong>
            <Trans>Coinbase tokenized stock metadata is temporarily unavailable</Trans>
          </strong>
          <p>
            <Trans>
              Ophis could not verify the corporate-action multiplier or transfer status. Quotes remain available, but
              confirm the token status before trading.{' '}
              <a href={COINBASE_TOKENIZED_STOCKS_DOCS} target="_blank" rel="noopener noreferrer">
                Read the Base documentation ↗
              </a>
            </Trans>
          </p>
        </styledEl.Content>
      </styledEl.Panel>
    )
  }

  if (selectedAssets.length === 0) return null

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
          <Trans>B20 token backed 1:1 by the underlying share; metadata read from the Base contracts.</Trans>
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
          <Trans>
            Coinbase tokenized stocks are available to persons in eligible jurisdictions outside the U.S. The executable
            price is always the Ophis solver quote.{' '}
            <a href={COINBASE_TOKENIZED_STOCKS_DOCS} target="_blank" rel="noopener noreferrer">
              How B20 stocks work ↗
            </a>
          </Trans>
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
  const sellIsStock = useIsCoinbaseStockToken(
    sellToken?.isToken && sellToken.chainId === BASE_CHAIN_ID ? sellToken : null,
  )
  const buyIsStock = useIsCoinbaseStockToken(buyToken?.isToken && buyToken.chainId === BASE_CHAIN_ID ? buyToken : null)
  const onBase =
    chainId === BASE_CHAIN_ID || sellToken?.chainId === BASE_CHAIN_ID || buyToken?.chainId === BASE_CHAIN_ID

  // Membership comes from the shipped token list, so the panel (and its metadata query)
  // only exists while a Coinbase stock is actually in the pair, never for every Base swap.
  return onBase && (sellIsStock || buyIsStock) ? (
    <CoinbaseStockContextContent sellToken={sellToken} buyToken={buyToken} sellBalance={sellBalance} />
  ) : null
}
