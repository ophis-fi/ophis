import { ReactNode, useEffect, useMemo, useState } from 'react'

import { ROBINHOOD_CHAIN_BRIDGE, ROBINHOOD_CHAIN_DOCS } from '@cowprotocol/common-const'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { UI } from '@cowprotocol/ui'

import styled from 'styled-components/macro'

import { findRobinhoodStockAsset, getRobinhoodStockAssets, hasTradingRestriction } from './data'

import type { RobinhoodStockAsset } from './types'

const ROBINHOOD_CHAIN_ID = 4663
const ONE_18 = 10n ** 18n

const Panel = styled.aside<{ $attention: boolean }>`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin: 2px 0;
  padding: 11px 12px;
  border: 1px solid ${({ $attention }) => ($attention ? 'rgba(255, 178, 55, 0.42)' : 'rgba(0, 200, 5, 0.28)')};
  border-radius: var(--ophis-radius-md, 16px);
  background: ${({ $attention }) =>
    $attention
      ? 'linear-gradient(120deg, rgba(255, 178, 55, 0.10), rgba(255, 178, 55, 0.025))'
      : 'linear-gradient(120deg, rgba(0, 200, 5, 0.085), rgba(0, 200, 5, 0.018))'};
  color: var(${UI.COLOR_TEXT_PAPER});
`

const Mark = styled.div`
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 9px;
  background: #00c805;
  color: #051006;
  font-size: 15px;
  font-weight: 900;
  box-shadow: 0 6px 18px rgba(0, 200, 5, 0.2);
`

const Content = styled.div`
  min-width: 0;

  strong {
    display: block;
    font-size: 13px;
    line-height: 1.3;
  }

  p {
    margin: 3px 0 0;
    color: var(${UI.COLOR_TEXT_OPACITY_70});
    font-size: 11px;
    line-height: 1.45;
  }

  a {
    color: inherit;
    font-weight: 650;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
`

function tokenAddress(currency: Currency | null): string | undefined {
  return currency?.isToken ? currency.address : undefined
}

function shareEquivalent(balance: CurrencyAmount<Currency> | null, multiplier: string): string | undefined {
  if (!balance) return undefined
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

export function RobinhoodAssetContext({
  chainId,
  sellToken,
  buyToken,
  sellBalance,
}: RobinhoodAssetContextProps): ReactNode {
  const [assets, setAssets] = useState<RobinhoodStockAsset[]>([])

  useEffect(() => {
    if (chainId !== ROBINHOOD_CHAIN_ID) return
    let active = true
    getRobinhoodStockAssets()
      .then((nextAssets) => {
        if (active) setAssets(nextAssets)
      })
      // Metadata enriches the interface but must never block a quote or trade.
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [chainId])

  const selectedAsset = useMemo(
    () =>
      findRobinhoodStockAsset(assets, tokenAddress(sellToken)) ??
      findRobinhoodStockAsset(assets, tokenAddress(buyToken)),
    [assets, buyToken, sellToken],
  )

  if (chainId !== ROBINHOOD_CHAIN_ID) return null

  if (!selectedAsset) {
    return (
      <Panel $attention={false}>
        <Mark>R</Mark>
        <Content>
          <strong>Robinhood Chain · gasless intent</strong>
          <p>
            Swaps are gasless. Approvals and wrapping still use ETH; paying a higher priority fee does not buy earlier
            ordering. Need funds? <a href={ROBINHOOD_CHAIN_BRIDGE}>Bridge to Robinhood Chain ↗</a>
          </p>
        </Content>
      </Panel>
    )
  }

  const restricted = hasTradingRestriction(selectedAsset)
  const selectedIsSell =
    tokenAddress(sellToken)?.toLowerCase() ===
    selectedAsset.deployments
      .find((deployment) => deployment.chainId === ROBINHOOD_CHAIN_ID)
      ?.contractAddress.toLowerCase()
  const equivalent = selectedIsSell ? shareEquivalent(sellBalance, selectedAsset.currentMultiplier) : undefined
  const multiplier = Number(selectedAsset.currentMultiplier)

  return (
    <Panel $attention={restricted || Boolean(selectedAsset.pendingMultiplier)}>
      <Mark>R</Mark>
      <Content>
        <strong>
          {selectedAsset.tokenSymbol} · official Robinhood Stock Token
          {restricted ? ' · check trading status' : ''}
        </strong>
        <p>
          Canonical deployment verified from Robinhood. Corporate-action multiplier: {multiplier.toLocaleString()}×
          {equivalent ? ` · Your displayed balance represents about ${equivalent} underlying shares.` : '.'}{' '}
          {selectedAsset.pendingMultiplier
            ? `A multiplier change to ${selectedAsset.pendingMultiplier} is pending. `
            : ''}
          The executable price is always the Ophis solver quote.{' '}
          <a href={`${ROBINHOOD_CHAIN_DOCS}stock-tokens/`}>How Stock Tokens work ↗</a>
        </p>
      </Content>
    </Panel>
  )
}
