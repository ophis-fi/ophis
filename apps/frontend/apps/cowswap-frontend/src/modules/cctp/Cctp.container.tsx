import { ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { cctpNetwork } from './cctp.const'
import { isCctpOwner } from './cctp.service'
import * as styledEl from './Cctp.styled'
import { CctpTransferDetails, CctpQuoteDetails } from './CctpTransfer.pure'
import { type useCctpSwapRoute } from './useCctpSwapRoute'
import { type useCctpTransfer } from './useCctpTransfer'

export function CctpSwapRecovery({ route }: { route: ReturnType<typeof useCctpSwapRoute> }): ReactNode {
  if (route.active) return null
  if (route.flow.transfer)
    return <CctpSwapDetails route={route} source={undefined} destination={undefined} amount={undefined} />
  return route.asset && route.blocked ? <p role="status">{route.blocked}</p> : null
}

export function CctpSwapDetails({
  route,
  source,
  destination,
  amount,
}: {
  route: ReturnType<typeof useCctpSwapRoute>
  source: number | undefined
  destination: number | undefined
  amount: string | undefined
}): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const { flow, asset, blocked } = route
  return (
    <styledEl.Card aria-label="Bridge details">
      {flow.transfer ? (
        <CctpPendingTransfer flow={flow} />
      ) : (
        <>
          <p>Via Circle CCTP · {asset} arrives at your wallet on the destination network.</p>
          {asset?.endsWith('on') && (
            <p>Tokenized securities may require issuer eligibility on the destination network.</p>
          )}
          {blocked ? (
            <p role="alert">{blocked}</p>
          ) : !account ? (
            <button type="button" onClick={connect}>
              Connect wallet
            </button>
          ) : flow.quote && source ? (
            <CctpQuoteDetails flow={flow} correctChain={chainId === source} source={source} />
          ) : (
            <button
              type="button"
              disabled={!!flow.busy || !amount || !source || !destination || !asset}
              onClick={() =>
                source && destination && amount && asset && flow.loadQuote(source, destination, amount, asset)
              }
            >
              Review bridge fee
            </button>
          )}
        </>
      )}
      {flow.busy && (
        <p role="status" aria-live="polite">
          {flow.busy}
        </p>
      )}
      {flow.error && <p role="alert">{flow.error}</p>}
    </styledEl.Card>
  )
}

function CctpPendingTransfer({ flow }: { flow: ReturnType<typeof useCctpTransfer> }): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const { transfer } = flow
  if (!transfer) return null
  return (
    <CctpTransferDetails
      transfer={transfer}
      status={flow.status}
      busy={!!flow.busy}
      canClaim={chainId === transfer.destination && isCctpOwner(transfer.owner, account)}
      onClaim={flow.claim}
      claimPreparation={
        !account
          ? { label: 'Connect wallet', action: connect }
          : chainId !== transfer.destination && isCctpOwner(transfer.owner, account)
            ? {
                label: `Switch to ${cctpNetwork(transfer.destination).chain.name}`,
                action: () => transfer && flow.switchNetwork(transfer.destination),
              }
            : undefined
      }
      onResume={flow.resume}
      onResumeClaim={flow.resumeClaim}
      onFinish={flow.finish}
    />
  )
}
