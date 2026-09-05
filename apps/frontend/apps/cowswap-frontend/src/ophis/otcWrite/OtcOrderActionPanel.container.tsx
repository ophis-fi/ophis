import { useAtomValue } from 'jotai'
import { useCallback, useId, useMemo, useState, type ReactNode } from 'react'

import { LinkStyledButton } from '@cowprotocol/ui'
import { useWalletInfo } from '@cowprotocol/wallet'

import { atomWithQuery } from 'jotai-tanstack-query'
import { Callout, Section } from 'ophis/ds'
import { readOtcOrder } from 'ophis/otc'
import { isAddressEqual } from 'viem'
import { useWalletClient } from 'wagmi'

import { OtcActionControl } from './OtcActionControl.container'
import { OtcOrderTermsSummary } from './OtcOrderTermsSummary.pure'
import * as styledEl from './OtcWrite.styled'
import { reviewedOtcToken, type OtcReviewedToken } from './otcWriteForm'
import { getOtcActionReviewKey, shouldMountOtcOrderAction } from './otcWriteOrder.utils'
import { useOtcNetworkReads } from './useOtcNetworkReads'
import { useOtcUsdAmount } from './useOtcUsdAmount'

import type { OtcConfirmedCallback } from './otcWrite.types'
import type { OtcActionDefinition } from './useOtcActionController'
import type { OtcOrder } from 'ophis/otc'
import type { Address, Hex } from 'viem'

const ORDER_REFRESH_INTERVAL_MS = 5_000

function buildOrderActionDefinition(
  account: Address | undefined,
  order: OtcOrder,
  isMaker: boolean,
  reviewed: boolean,
  resetKey: string,
  paymentToken: OtcReviewedToken | null,
  receivedToken: OtcReviewedToken | null,
): OtcActionDefinition {
  const reviewedTerms = !!paymentToken && !!receivedToken
  return {
    executeLabel: isMaker ? 'Cancel order' : 'Fill entire order',
    unavailableLabel: order.active ? 'Order terms unavailable' : 'Order is inactive',
    ready: order.active && reviewedTerms,
    reviewed,
    resetKey,
    executeIntent: account
      ? isMaker
        ? { kind: 'cancel', account, order }
        : { kind: 'fill', account, order, deadline: 1n }
      : null,
    approvalIntent: account && !isMaker ? { kind: 'approve-fill', account, order } : null,
    revokeIntent: account && !isMaker ? { kind: 'revoke-fill', account, order } : null,
    allowanceToken: !isMaker ? order.tokenB : null,
    allowanceTokenDecimals: paymentToken?.decimals,
    allowanceTokenSymbol: paymentToken?.symbol,
    requiredAllowance: !isMaker ? order.amountB : null,
  }
}

function VerifiedOtcOrderActionPanel({
  order,
  onConfirmed,
}: {
  order: OtcOrder
  onConfirmed?: OtcConfirmedCallback
}): ReactNode {
  const { account } = useWalletInfo()
  const [reviewedKey, setReviewedKey] = useState<string | null>(null)
  const isMaker = !!account && isAddressEqual(account, order.maker)
  const paymentToken = reviewedOtcToken(order.tokenB)
  const receivedToken = reviewedOtcToken(order.tokenA)
  const paymentUsd = useOtcUsdAmount(isMaker ? null : paymentToken, isMaker ? null : order.amountB)
  const receivedUsd = useOtcUsdAmount(isMaker ? null : receivedToken, isMaker ? null : order.amountA)
  const resetKey = getOtcActionReviewKey(account, [
    isMaker ? 'cancel' : 'fill',
    order.orderId,
    order.maker,
    order.tokenA,
    order.amountA,
    order.tokenB,
    order.amountB,
  ])
  const reviewed = reviewedKey === resetKey
  const definition = useMemo(
    () => buildOrderActionDefinition(account, order, isMaker, reviewed, resetKey, paymentToken, receivedToken),
    [account, isMaker, order, paymentToken, receivedToken, resetKey, reviewed],
  )

  return (
    <Section
      id="otc-order-action"
      title={
        !order.active ? 'Recover token allowance' : isMaker ? 'Cancel order on local fork' : 'Fill order on local fork'
      }
    >
      <Callout tone="warning" title="Fork-only transaction mode">
        <p>
          {order.active
            ? 'Preflight re-reads these exact terms and simulates the call before your wallet is asked to submit.'
            : 'This order is inactive. Only a positive existing escrow allowance can be revoked.'}
        </p>
      </Callout>
      <OtcOrderTermsSummary
        isMaker={isMaker}
        order={order}
        paymentToken={paymentToken}
        receivedToken={receivedToken}
        paymentUsdValue={paymentUsd.value}
        paymentUsdLoading={paymentUsd.isLoading}
        receivedUsdValue={receivedUsd.value}
        receivedUsdLoading={receivedUsd.isLoading}
      />
      {order.active && (
        <styledEl.ReviewLabel>
          <input
            type="checkbox"
            checked={reviewed}
            onChange={(event) => setReviewedKey(event.target.checked ? resetKey : null)}
          />
          {isMaker
            ? 'I reviewed the exact order and understand cancellation costs Ethereum gas.'
            : 'I reviewed both exact token amounts, allowance, escrow risks, and race risk.'}
        </styledEl.ReviewLabel>
      )}
      <OtcActionControl definition={definition} onConfirmed={onConfirmed} />
    </Section>
  )
}

function UnverifiedOtcOrderActionPanel({
  orderId,
  onConfirmed,
  confirmedHash,
  orderUnavailable,
  retryOrder,
}: {
  orderId: bigint
  onConfirmed?: OtcConfirmedCallback
  confirmedHash: Hex | null
  orderUnavailable: boolean
  retryOrder(): void
}): ReactNode {
  const definition = useMemo<OtcActionDefinition>(
    () => ({
      executeLabel: 'Order action',
      unavailableLabel: orderUnavailable ? 'Fork order unavailable' : 'Loading verified fork order...',
      ready: false,
      reviewed: false,
      resetKey: `order:${orderId.toString()}:unverified`,
      executeIntent: null,
      approvalIntent: null,
      revokeIntent: null,
      allowanceToken: null,
      requiredAllowance: null,
    }),
    [orderId, orderUnavailable],
  )
  return (
    <Section id="otc-order-action" title="Order action on local fork">
      {!orderUnavailable && (
        <Callout tone="warning" title="Fork verification required">
          <p>Connect a wallet and select a chain-id-1 local fork before the exact order terms can be loaded.</p>
        </Callout>
      )}
      {orderUnavailable && (
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <Callout tone="warning" title="Fork order unavailable">
            <p>The verified local-fork order read failed. Check Anvil, then retry this exact order.</p>
            <LinkStyledButton type="button" onClick={retryOrder}>
              Retry fork order
            </LinkStyledButton>
          </Callout>
        </div>
      )}
      {confirmedHash && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <Callout tone="success" title="Transaction confirmed">
            <p>Local fork confirmation: {confirmedHash}</p>
          </Callout>
        </div>
      )}
      <OtcActionControl definition={definition} onConfirmed={onConfirmed} />
    </Section>
  )
}

export function OtcOrderActionPanel({
  orderId,
  onConfirmed,
}: {
  orderId: bigint
  onConfirmed?: () => void
}): ReactNode {
  const mountId = useId()
  const [confirmedHash, setConfirmedHash] = useState<Hex | null>(null)
  const { account, chainId } = useWalletInfo()
  const { data: walletClient } = useWalletClient()
  const network = useOtcNetworkReads(true, account, chainId, walletClient, null)
  const forkOrderQueryAtom = useMemo(
    () =>
      atomWithQuery<Awaited<ReturnType<typeof readOtcOrder>> | null, Error>(() => ({
        queryKey: ['ophis-otc-fork-order', network.transportId, account, orderId.toString(), mountId],
        queryFn: async () => (network.writeClient ? readOtcOrder(network.writeClient, orderId) : null),
        enabled: !!network.localForkResponse.data && !!account && !!network.writeClient,
        refetchInterval: ORDER_REFRESH_INTERVAL_MS,
        refetchOnWindowFocus: false,
      })),
    [account, mountId, network.localForkResponse.data, network.transportId, network.writeClient, orderId],
  )
  const forkOrderQuery = useAtomValue(forkOrderQueryAtom)
  const order = forkOrderQuery.data?.order ?? null
  const refetchForkOrder = forkOrderQuery.refetch
  const retryOrder = useCallback(() => {
    void refetchForkOrder()
  }, [refetchForkOrder])
  const handleConfirmed = useCallback(
    (transactionHash: Hex) => {
      setConfirmedHash(transactionHash)
      void refetchForkOrder()
      onConfirmed?.()
    },
    [onConfirmed, refetchForkOrder],
  )
  const orderUnavailable = !!network.localForkResponse.data && forkOrderQuery.error !== null

  if (!network.localForkResponse.data || !shouldMountOtcOrderAction(true, order) || !order) {
    return (
      <UnverifiedOtcOrderActionPanel
        orderId={orderId}
        onConfirmed={onConfirmed}
        confirmedHash={confirmedHash}
        orderUnavailable={orderUnavailable}
        retryOrder={retryOrder}
      />
    )
  }
  return <VerifiedOtcOrderActionPanel order={order} onConfirmed={handleConfirmed} />
}
