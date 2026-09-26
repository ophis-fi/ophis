import { ReactNode } from 'react'

import { useMachineTimeMs } from '@cowprotocol/common-hooks'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { BtcSwapAmounts, BtcSwapReceived } from './BtcSwapAmounts.container'
import { isCctpOwner } from './cctp.service'
import * as styledEl from './Cctp.styled'
import { CctpHashRecovery, CctpQuoteDetails } from './CctpTransfer.pure'
import { type useCctpSwapRoute } from './useCctpSwapRoute'

type Route = ReturnType<typeof useCctpSwapRoute>

export function BtcCctpSwap({ route }: { route: Route }): ReactNode {
  return (
    <styledEl.Card aria-label="WBTC to Arc route">
      <p>WBTC → cirBTC on Ethereum → cirBTC on Arc</p>
      <p>First swap on Ethereum, then bridge to Arc. Confirm each step here.</p>
      {route.btc.pending ? <BtcSwapRecovery route={route} /> : <BtcSwapReview route={route} />}
      {route.flow.busy && (
        <p role="status" aria-live="polite">
          {route.flow.busy}
        </p>
      )}
      {route.flow.error && <p role="alert">{route.flow.error}</p>}
    </styledEl.Card>
  )
}

function BtcSwapRecovery({ route }: { route: Route }): ReactNode {
  const { account, chainId } = useWalletInfo()
  const { btc, flow } = route
  const { pending } = btc
  if (!pending) return null
  const wrongOwner = !isCctpOwner(pending.owner, account)
  return (
    <>
      <a href={`https://explorer.cow.fi/orders/${pending.orderUid}`} target="_blank" rel="noopener noreferrer">
        View Ethereum swap
      </a>
      <p role="status">{btc.tracking.status?.text || 'Checking your saved swap…'}</p>
      {wrongOwner ? (
        <p>Connect {pending.owner} to continue this route.</p>
      ) : (
        btc.tracking.status?.amount && (
          <>
            <BtcSwapReceived amount={btc.tracking.status.amount} />
            {flow.quote?.swapOrderUid === pending.orderUid && (
              <CctpQuoteDetails flow={flow} correctChain={chainId === 1} source={1} />
            )}
            <button type="button" disabled={!!flow.busy} onClick={btc.continueBridge}>
              {flow.quote ? 'Refresh bridge fee' : 'Continue to bridge'}
            </button>
          </>
        )
      )}
      {btc.tracking.status?.ended && !wrongOwner && (
        <button type="button" disabled={!!flow.busy} onClick={btc.finish}>
          End expired route
        </button>
      )}
      {!btc.tracking.status?.amount && (
        <CctpHashRecovery label="Ethereum swap transaction hash" busy={!!flow.busy} onResume={btc.recover} />
      )}
      {btc.tracking.error && <p role="alert">{btc.tracking.error}</p>}
    </>
  )
}

function BtcSwapReview({ route }: { route: Route }): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const now = useMachineTimeMs(1000)
  const { btc, flow } = route
  const expired = !btc.quote || now - btc.quote.quotedAt >= 60_000
  return (
    <>
      {btc.quote && <BtcSwapAmounts quote={btc.quote} />}
      <p>
        Swap fees are included. Ethereum approval gas and the bridge fee are paid separately. The bridge fee is
        refreshed after the swap.
      </p>
      {!account ? (
        <button type="button" onClick={connect}>
          Connect wallet
        </button>
      ) : route.blocked ? (
        <p role="alert">{route.blocked}</p>
      ) : (
        <button
          type="button"
          disabled={!!flow.busy}
          onClick={
            chainId !== 1 ? () => flow.switchNetwork(1) : expired ? btc.review : btc.approved ? btc.swap : btc.approve
          }
        >
          {chainId !== 1
            ? 'Switch to Ethereum'
            : expired
              ? 'Review swap and bridge'
              : btc.approved
                ? 'Swap WBTC to cirBTC'
                : 'Approve WBTC'}
        </button>
      )}
    </>
  )
}
