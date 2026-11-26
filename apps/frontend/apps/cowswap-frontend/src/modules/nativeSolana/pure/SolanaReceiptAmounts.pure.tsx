import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { useAssetVerification, VerifiedAssetBadge } from 'entities/verifiedAsset'
import { ArrowDown } from 'react-feather'

import { AssetIcon } from './AssetPicker.pure'
import * as styledEl from './SolanaReceipt.styled'
import { AmountText, Line } from './SwapForm.styled'

import { solanaAssetIdentity, type SolanaAsset } from '../services/assets.service'
import { receiptAmount, type ReceiptAmounts } from '../services/receipt.service'

import type { OphisSolanaOrder, OphisSolanaTrade } from '@ophis/solana-sdk'

function AssetSlab({
  label,
  amount,
  mint,
  assets,
}: {
  label: ReactNode
  amount: string
  mint: string
  assets: SolanaAsset[]
}): ReactNode {
  const { asset, value } = receiptAmount(amount, mint, assets)
  const verified = useAssetVerification(solanaAssetIdentity(asset))
  return (
    <styledEl.Slab>
      <Line>
        <small>{label}</small>
        <styledEl.Token title={mint}>
          <styledEl.CoinStack>
            <AssetIcon asset={asset} />
          </styledEl.CoinStack>
          {asset.symbol}
          <VerifiedAssetBadge verified={verified} />
        </styledEl.Token>
      </Line>
      <AmountText>
        {value}
        {asset.decimals === undefined && (
          <>
            {' '}
            <Trans>base units</Trans>
          </>
        )}
      </AmountText>
    </styledEl.Slab>
  )
}

export function ReceiptAmount({
  amount,
  mint,
  assets,
}: {
  amount: string
  mint: string
  assets: SolanaAsset[]
}): ReactNode {
  const { asset, value } = receiptAmount(amount, mint, assets)
  return (
    <span title={mint}>
      {value}{' '}
      {asset.decimals === undefined && (
        <>
          <Trans>base units</Trans>{' '}
        </>
      )}
      {asset.symbol}
    </span>
  )
}

export function ReceiptSlabs({
  trade,
  data,
  intent,
  assets,
}: {
  trade?: OphisSolanaTrade
  data?: OphisSolanaOrder
  assets: SolanaAsset[]
  intent?: ReceiptAmounts
}): ReactNode {
  const amounts = trade ?? intent
  const received = trade?.buyAmount ?? (data?.status === 'fulfilled' ? data.executedBuyAmount : undefined)
  const sold = trade?.sellAmount ?? (data?.status === 'fulfilled' ? data.executedSellAmount : undefined)
  if (!amounts) return null
  return (
    <styledEl.Slabs>
      <AssetSlab
        label={sold ? <Trans>You sold</Trans> : <Trans>You sell</Trans>}
        amount={sold ?? amounts.sellAmount}
        mint={amounts.sellToken}
        assets={assets}
      />
      <styledEl.Flow aria-hidden="true">
        <ArrowDown size={15} />
      </styledEl.Flow>
      {received !== undefined ? (
        <AssetSlab label={<Trans>You received</Trans>} amount={received} mint={amounts.buyToken} assets={assets} />
      ) : (
        intent && (
          <AssetSlab
            label={<Trans>Minimum to receive</Trans>}
            amount={intent.buyAmount}
            mint={intent.buyToken}
            assets={assets}
          />
        )
      )}
    </styledEl.Slabs>
  )
}
