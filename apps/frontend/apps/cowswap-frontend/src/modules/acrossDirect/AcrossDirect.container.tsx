import { useAtomValue } from 'jotai'
import { ReactNode } from 'react'

import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { cctpNetwork } from 'entities/cctp'
import { formatUnits } from 'viem'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import * as styledEl from './AcrossDirect.styled'
import { acrossPendingAtom } from './acrossState.service'
import { type useAcrossDirect } from './useAcrossDirect'

export function AcrossDirect({ route }: { route: ReturnType<typeof useAcrossDirect> }): ReactNode {
  const pending = useAtomValue(acrossPendingAtom)
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const { quote, busy, error, expired } = route
  if (pending) return null
  return (
    <styledEl.Card aria-label="Across bridge details">
      <p>Via Across · Send USDC from Arc.</p>
      {quote && (
        <>
          <p>
            Receive {formatUnits(BigInt(quote.output), 6)} USDC on {cctpNetwork(quote.destination).chain.name}.
          </p>
          <p>
            Bridge fee: {formatUnits(BigInt(quote.amount) - BigInt(quote.output), 6)} USDC. Arc network fees are paid
            separately.
          </p>
          <p>Receiving address: {quote.recipient}</p>
        </>
      )}
      {!account ? (
        <button type="button" onClick={connect}>
          Connect wallet
        </button>
      ) : chainId !== ARC_CHAIN_ID ? (
        <button type="button" disabled={!!busy} onClick={route.switchNetwork}>
          Switch to Arc
        </button>
      ) : (
        <>
          <button type="button" disabled={!!busy || !route.canQuote} onClick={route.load}>
            {quote ? 'Refresh Across quote' : 'Review Across bridge'}
          </button>
          {quote &&
            (route.needsApproval ? (
              <button type="button" disabled={!!busy || expired} onClick={route.approve}>
                Approve USDC
              </button>
            ) : (
              <button type="button" disabled={!!busy || expired} onClick={route.send}>
                Bridge with Across
              </button>
            ))}
          {expired && <p role="status">Quote expired. Refresh before continuing.</p>}
        </>
      )}
      {busy && (
        <p role="status" aria-live="polite">
          {busy}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </styledEl.Card>
  )
}
