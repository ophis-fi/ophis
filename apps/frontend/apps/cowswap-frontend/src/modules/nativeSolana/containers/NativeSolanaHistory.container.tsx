import { useAtomValue } from 'jotai'
import { ReactNode, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { solanaConnectionAtom } from 'entities/solana'

import { NativeSolanaOrderCard } from './NativeSolanaOrders.container'
import { SolanaSettlementTime } from './SolanaSettlementTime.container'

import { Card, Row } from '../pure/NativeSolana.styled'
import { ReceiptStatusBadge, SolanaReceipt } from '../pure/SolanaReceipt.pure'
import { Activity } from '../pure/SolanaReceipt.styled'
import { ReceiptAmount } from '../pure/SolanaReceiptAmounts.pure'
import { shortMint, type SolanaAsset } from '../services/assets.service'
import { savedReceiptAmounts, savedReceiptStatus } from '../services/receipt.service'
import { solanaCachedCatalogAtom, solanaMainnetCatalogAtom, walletAssetListAtom } from '../state/assets.atoms'
import { historyAtom, indexedOrderAtom, pageSize } from '../state/history.atoms'
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
    <Activity type="button" onClick={select}>
      <span>
        <strong>
          {amounts ? (
            <ReceiptAmount amount={amounts.sellAmount} mint={amounts.sellToken} assets={assets} />
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
    </Activity>
  )
}

function IndexedReceipt({ trade, onBack }: { trade: OphisSolanaTrade; onBack(): void }): ReactNode {
  const { data } = useAtomValue(indexedOrderAtom(trade.orderUid))
  const assets = useAtomValue(walletAssetListAtom)
  const order = data?.sellToken === trade.sellToken && data.buyToken === trade.buyToken ? data : undefined
  return (
    <SolanaReceipt
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
  const { data, isFetching, isError, refetch } = useAtomValue(historyAtom(page))
  const saved = useAtomValue(visibleNativeSolanaOrdersAtom)
  useAtomValue(data?.length || saved.length ? solanaMainnetCatalogAtom : solanaCachedCatalogAtom)
  const assets = useAtomValue(walletAssetListAtom)
  if (!connection) return null
  const order = saved.find((entry) => entry.uid === selected?.uid)
  const trade = selected?.trade
  const back = (): void => select(undefined)
  if (order) return <NativeSolanaOrderCard key={order.uid} order={order} indexed={trade} onBack={back} />
  if (trade?.owner === connection.account.address) return <IndexedReceipt trade={trade} onBack={back} />
  const local =
    page === 0
      ? saved
          .filter((order) => !data?.some((row) => row.orderUid === order.uid))
          .sort((a, b) => (b.creationLifetime?.requestedAt ?? 0) - (a.creationLifetime?.requestedAt ?? 0))
      : []
  return (
    <Card>
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
      {data?.length === 0 && !local.length && (
        <p>
          <Trans>No trades on this page.</Trans>
        </p>
      )}
      {data?.map((row) => (
        <Activity
          key={row.txSignature + row.instructionIndex + row.orderUid}
          type="button"
          onClick={() => select({ uid: row.orderUid, trade: row })}
        >
          <span>
            <strong>
              <ReceiptAmount amount={row.sellAmount} mint={row.sellToken} assets={assets} /> →{' '}
              <ReceiptAmount amount={row.buyAmount} mint={row.buyToken} assets={assets} />
            </strong>
            <small>
              <Trans>View receipt</Trans>
            </small>
          </span>
          <ReceiptStatusBadge status="fulfilled" />
        </Activity>
      ))}
      {local.slice(0, visibleSaved).map((entry) => (
        <SavedActivity key={entry.uid} order={entry} assets={assets} select={() => select({ uid: entry.uid })} />
      ))}
      {local.length > visibleSaved && (
        <ButtonSecondary type="button" onClick={() => setVisibleSaved(visibleSaved + pageSize)}>
          <Trans>Show more orders</Trans>
        </ButtonSecondary>
      )}
      <Row>
        <ButtonSecondary type="button" disabled={isFetching} onClick={() => void refetch()}>
          <Trans>Refresh trades</Trans>
        </ButtonSecondary>
        {page > 0 && (
          <ButtonSecondary type="button" onClick={() => setPage(page - 1)}>
            <Trans>Previous</Trans>
          </ButtonSecondary>
        )}
        {data?.length === pageSize && (
          <ButtonSecondary type="button" onClick={() => setPage(page + 1)}>
            <Trans>Next</Trans>
          </ButtonSecondary>
        )}
      </Row>
    </Card>
  )
}
