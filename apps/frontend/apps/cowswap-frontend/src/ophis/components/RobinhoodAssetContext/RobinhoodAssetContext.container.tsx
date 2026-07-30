import { useAtomValue } from 'jotai'
import { ReactNode, useMemo } from 'react'

import { ROBINHOOD_CHAIN_BRIDGE, ROBINHOOD_CHAIN_DOCS } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { Trans } from '@lingui/react/macro'

import { findRobinhoodStockAsset, hasTradingRestriction } from './data'
import { robinhoodAssetsQueryAtom } from './RobinhoodAssetContext.atoms'
import * as styledEl from './RobinhoodAssetContext.styled'

import type { RobinhoodStockAsset } from './types'

const ROBINHOOD_CHAIN_ID = 4663
const ONE_18 = 10n ** 18n
const ROBINHOOD_MARK = (
  <styledEl.Mark>
    <img src="/robinhood-feather.svg" alt="" aria-hidden="true" />
  </styledEl.Mark>
)

function tokenAddress(currency: Currency | null): string | undefined {
  return currency?.chainId === ROBINHOOD_CHAIN_ID && currency.isToken ? currency.address : undefined
}

function shareEquivalent(balance: CurrencyAmount<Currency> | null, multiplier: string): string | undefined {
  if (!balance || balance.currency.chainId !== ROBINHOOD_CHAIN_ID) return undefined
  const [whole = '0', fraction = ''] = multiplier.split('.')
  const multiplierRaw = BigInt(whole) * ONE_18 + BigInt(fraction.padEnd(18, '0').slice(0, 18))
  if (multiplierRaw === ONE_18) return undefined
  const shareRaw = (BigInt(balance.quotient.toString()) * multiplierRaw) / ONE_18
  return CurrencyAmount.fromRawAmount(balance.currency, shareRaw.toString()).toSignificant(6)
}

export interface RobinhoodAssetContextProps {
  chainId: number | undefined
  sellToken: Currency | null
  buyToken: Currency | null
  sellBalance: CurrencyAmount<Currency> | null
}

function RobinhoodAssetContextContent({
  sellToken,
  buyToken,
  sellBalance,
}: Omit<RobinhoodAssetContextProps, 'chainId'>): ReactNode {
  const { data: assets = [], isError } = useAtomValue(robinhoodAssetsQueryAtom)
  const selectedAssets = useMemo(
    () =>
      [tokenAddress(sellToken), tokenAddress(buyToken)]
        .map((address) => findRobinhoodStockAsset(assets, address))
        .filter(
          (asset, index, all): asset is RobinhoodStockAsset =>
            Boolean(asset) && all.findIndex((candidate) => candidate?.id === asset?.id) === index,
        ),
    [assets, buyToken, sellToken],
  )

  if (isError && assets.length === 0) {
    return (
      <styledEl.Panel $attention>
        {ROBINHOOD_MARK}
        <styledEl.Content>
          <strong>
            <Trans>Robinhood Stock Token metadata is temporarily unavailable</Trans>
          </strong>
          <p>
            <Trans>
              Ophis could not verify current restrictions or corporate-action multipliers. Quotes remain available, but
              confirm the token status before trading.{' '}
              <a href={`${ROBINHOOD_CHAIN_DOCS}stock-tokens/`}>Check Robinhood documentation ↗</a>
            </Trans>
          </p>
        </styledEl.Content>
      </styledEl.Panel>
    )
  }

  if (selectedAssets.length === 0) {
    return (
      <styledEl.Panel $attention={false}>
        {ROBINHOOD_MARK}
        <styledEl.Content>
          <strong>
            <Trans>Robinhood Chain · gasless intent</Trans>
          </strong>
          <p>
            <Trans>
              Swaps are gasless. Approvals and wrapping still use ETH; paying a higher priority fee does not buy earlier
              ordering. Need funds? <a href={ROBINHOOD_CHAIN_BRIDGE}>Bridge to Robinhood Chain ↗</a>
            </Trans>
          </p>
        </styledEl.Content>
      </styledEl.Panel>
    )
  }

  const restrictedAssets = selectedAssets.filter(hasTradingRestriction)
  const restrictedSymbols = restrictedAssets.map((asset) => asset.tokenSymbol).join(', ')
  const selectedSymbols = selectedAssets.map((asset) => asset.tokenSymbol).join(', ')
  const hasPendingMultiplier = selectedAssets.some((asset) => Boolean(asset.pendingMultiplier))

  return (
    <styledEl.Panel $attention={restrictedAssets.length > 0 || hasPendingMultiplier}>
      {ROBINHOOD_MARK}
      <styledEl.Content>
        <strong>
          <Trans>{selectedSymbols} · official Robinhood Stock Token</Trans>
          {restrictedSymbols ? <Trans> · check trading status for {restrictedSymbols}</Trans> : null}
        </strong>
        <p>
          <Trans>Canonical deployments verified from Robinhood.</Trans>
          {selectedAssets.map((asset) => {
            const symbol = asset.tokenSymbol
            const multiplier = Number(asset.currentMultiplier).toLocaleString()
            const pendingMultiplier = asset.pendingMultiplier
            const deployment = asset.deployments.find((item) => item.chainId === ROBINHOOD_CHAIN_ID)
            const selectedIsSell = areAddressesEqual(tokenAddress(sellToken), deployment?.contractAddress)
            const equivalent = selectedIsSell ? shareEquivalent(sellBalance, asset.currentMultiplier) : undefined

            return (
              <styledEl.AssetDetail key={asset.id}>
                <Trans>
                  {symbol}: corporate-action multiplier {multiplier}×.
                </Trans>
                {equivalent ? (
                  <Trans> Your displayed balance represents about {equivalent} underlying shares.</Trans>
                ) : null}
                {pendingMultiplier ? <Trans> A multiplier change to {pendingMultiplier} is pending.</Trans> : null}
              </styledEl.AssetDetail>
            )
          })}
          <Trans>
            The executable price is always the Ophis solver quote.{' '}
            <a href={`${ROBINHOOD_CHAIN_DOCS}stock-tokens/`}>How Stock Tokens work ↗</a>
          </Trans>
        </p>
      </styledEl.Content>
    </styledEl.Panel>
  )
}

export function RobinhoodAssetContext({
  chainId,
  sellToken,
  buyToken,
  sellBalance,
}: RobinhoodAssetContextProps): ReactNode {
  const applies =
    chainId === ROBINHOOD_CHAIN_ID ||
    sellToken?.chainId === ROBINHOOD_CHAIN_ID ||
    buyToken?.chainId === ROBINHOOD_CHAIN_ID

  return applies ? (
    <RobinhoodAssetContextContent sellToken={sellToken} buyToken={buyToken} sellBalance={sellBalance} />
  ) : null
}
