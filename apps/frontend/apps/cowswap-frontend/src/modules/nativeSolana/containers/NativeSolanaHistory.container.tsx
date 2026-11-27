import { useAtomValue } from 'jotai'
import { ReactNode, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'
import { useAssetVerificationResolver } from 'entities/verifiedAsset'

import { NativeSolanaOrderCard } from './NativeSolanaOrders.container'
import { SolanaSettlementTime } from './SolanaSettlementTime.container'

import * as styledEl from '../pure/NativeSolana.styled'
import { ReceiptStatusBadge, SolanaReceipt } from '../pure/SolanaReceipt.pure'
import * as receiptStyles from '../pure/SolanaReceipt.styled'
import { ReceiptAmount } from '../pure/SolanaReceiptAmounts.pure'
import { isSolanaMainnet, shortMint, type SolanaAsset } from '../services/assets.service'
import { receiptSellToken, savedReceiptAmounts, savedReceiptStatus } from '../services/receipt.service'
import { solanaCachedCatalogAtom, solanaMainnetCatalogAtom, walletAssetListAtom } from '../state/assets.atoms'
import { indexedOrderAtom, pageSize, walletActivityAtom } from '../state/history.atoms'
import {
  nativeSolanaOrderQueryAtom,
  visibleNativeSolanaOrdersAtom,
  type SavedNativeSolanaOrder,
} from '../state/orders.atoms'

import type { OphisSolanaTrade } from '@ophis/solana-sdk'

function SavedActivity({
  order,
  assets,
  select,
}: {
  order: SavedNativeSolanaOrder
  assets: SolanaAsset[]
  select(): void
}): ReactNode {
  const { data, isError } = useAtomValue(nativeSolanaOrderQueryAtom(order.uid))
  const amounts = data && 'uid' in data ? data : savedReceiptAmounts(order)
  const status = savedReceiptStatus(order, data)
  return (
    <receiptStyles.Activity type="button" onClick={select}>
      <span>
        <strong>
          {amounts ? (
            <ReceiptAmount
              amount={amounts.sellAmount}
              mint={receiptSellToken(amounts.sellToken, order)}
              assets={assets}
            />
          ) : (
            <Trans>Swap attempt</Trans>
          )}
        </strong>
        <small>
          <Trans>View order</Trans> · {shortMint(order.uid)}
        </small>
      </span>
      {status !== 'pending' ? (
        <ReceiptStatusBadge status={status} />
      ) : isError ? (
        <Trans>Check status</Trans>
      ) : (
        <Trans>Checking status</Trans>
      )}
    </receiptStyles.Activity>
  )
}

function IndexedReceipt({ trade, onBack }: { trade: OphisSolanaTrade; onBack(): void }): ReactNode {
  const { data } = useAtomValue(indexedOrderAtom(trade.orderUid))
  const assets = useAtomValue(walletAssetListAtom)
  const order = data?.sellToken === trade.sellToken && data.buyToken === trade.buyToken ? data : undefined
  const verifyAsset = useAssetVerificationResolver(isSolanaMainnet)
  return (
    <SolanaReceipt
      verifyAsset={verifyAsset}
      timing={<SolanaSettlementTime slot={trade.slot} created={order?.creationDate} />}
      trade={trade}
      data={order}
      status="fulfilled"
      assets={assets}
      onBack={onBack}
    />
  )
}

export function NativeSolanaHistory(): ReactNode {
  const connection = useAtomValue(solanaConnectionAtom)
  const [visibleSaved, setVisibleSaved] = useState(pageSize)
  const [page, setPage] = useState(0)
  const [selected, select] = useState<{ uid: string; trade?: OphisSolanaTrade }>()
  const { trades, saved: local, hasMore, isFetching, isError, refresh } = useAtomValue(walletActivityAtom(page))
  const saved = useAtomValue(visibleNativeSolanaOrdersAtom)
  useAtomValue(trades.length || saved.length ? solanaMainnetCatalogAtom : solanaCachedCatalogAtom)
  const assets = useAtomValue(walletAssetListAtom)
  if (!connection) return null
  const order = saved.find((entry) => entry.uid === selected?.uid)
  const trade = selected?.trade
  const back = (): void => select(undefined)
  if (order) return <NativeSolanaOrderCard key={order.uid} order={order} indexed={trade} onBack={back} />
  if (trade?.owner === connection.account.address) return <IndexedReceipt trade={trade} onBack={back} />
  return (
    <styledEl.Card>
      <h3>
        <Trans>Solana activity</Trans>
      </h3>
      <small>
        {connection.wallet.name} · <code>{connection.account.address}</code>
      </small>
      {isError && (
        <p role="alert">
          <Trans>Could not load wallet trades.</Trans>
        </p>
      )}
      {!isFetching && !isError && !trades.length && !local.length && (
        <p>
          <Trans>No trades on this page.</Trans>
        </p>
      )}
      {trades.map((row) => (
        <receiptStyles.Activity
          key={row.txSignature + row.instructionIndex + row.orderUid}
          type="button"
          onClick={() => select({ uid: row.orderUid, trade: row })}
        >
          <span>
            <strong>
              <ReceiptAmount
                amount={row.sellAmount}
                mint={receiptSellToken(
                  row.sellToken,
                  saved.find((entry) => entry.uid === row.orderUid),
                )}
                assets={assets}
              />{' '}
              → <ReceiptAmount amount={row.buyAmount} mint={row.buyToken} assets={assets} />
            </strong>
            <small>
              <Trans>View receipt</Trans>
            </small>
          </span>
          <ReceiptStatusBadge status="fulfilled" />
        </receiptStyles.Activity>
      ))}
      {local.slice(0, visibleSaved).map((entry) => (
        <SavedActivity key={entry.uid} order={entry} assets={assets} select={() => select({ uid: entry.uid })} />
      ))}
      {local.length > visibleSaved && (
        <ButtonSecondary type="button" onClick={() => setVisibleSaved(visibleSaved + pageSize)}>
          <Trans>Show more orders</Trans>
        </ButtonSecondary>
      )}
      <styledEl.Row>
        <ButtonSecondary type="button" disabled={isFetching} onClick={() => void refresh()}>
          <Trans>Refresh trades</Trans>
        </ButtonSecondary>
        {page > 0 && (
          <ButtonSecondary type="button" onClick={() => setPage(page - 1)}>
            <Trans>Show fewer trades</Trans>
          </ButtonSecondary>
        )}
        {hasMore && (
          <ButtonSecondary type="button" onClick={() => setPage(page + 1)}>
            <Trans>Show more trades</Trans>
          </ButtonSecondary>
        )}
      </styledEl.Row>
    </styledEl.Card>
  )
}
