import { ReactNode, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { PageShell } from 'ophis/ds'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { Web3Status } from 'modules/wallet'

import { CCTP_ENABLED } from 'common/constants/featureFlags'

import { CCTP_NETWORKS } from './cctp.const'
import { isCctpOwner } from './cctp.service'
import * as styledEl from './Cctp.styled'
import { CctpTransferDetails, CctpQuoteDetails } from './CctpTransfer.pure'
import { useCctpTransfer } from './useCctpTransfer'

function CctpForm(): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const flow = useCctpTransfer()
  const [source, setSource] = useState(8453)
  const [destination, setDestination] = useState(5042)
  const [amount, setAmount] = useState('')
  const correctChain = chainId === source
  return (
    <styledEl.Card aria-label="CCTP USDC bridge">
      <Web3Status hideConnectButton />
      {flow.transfer ? (
        <CctpTransferDetails
          transfer={flow.transfer}
          status={flow.status}
          busy={!!flow.busy}
          canClaim={chainId === flow.transfer.destination && isCctpOwner(flow.transfer.owner, account)}
          onClaim={flow.claim}
          onResume={flow.resume}
          onFinish={flow.finish}
        />
      ) : (
        <>
          <label>
            From
            <select
              value={source}
              disabled={!!flow.busy}
              onChange={(event) => {
                setSource(Number(event.target.value))
                flow.clearQuote()
              }}
            >
              {CCTP_NETWORKS.map(({ chain }) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <select
              value={destination}
              disabled={!!flow.busy}
              onChange={(event) => {
                setDestination(Number(event.target.value))
                flow.clearQuote()
              }}
            >
              {CCTP_NETWORKS.map(({ chain }) => (
                <option key={chain.id} value={chain.id}>
                  {chain.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            USDC amount
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              disabled={!!flow.busy}
              onChange={(event) => {
                setAmount(event.target.value)
                flow.clearQuote()
              }}
            />
          </label>
          <p>
            For personal wallets only. USDC arrives at the same address on the destination network. Circle’s forwarding
            fee is deducted from the amount.
          </p>
          {account ? (
            <button
              type="button"
              disabled={!!flow.busy || source === destination || !amount}
              onClick={() => flow.loadQuote(source, destination, amount)}
            >
              Review bridge fee
            </button>
          ) : (
            <button type="button" onClick={connect}>
              Connect wallet
            </button>
          )}
          {flow.quote && <CctpQuoteDetails flow={flow} correctChain={correctChain} source={source} />}
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

export function CctpPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Circle CCTP"
      title="Bridge USDC"
      lede="Transfer native USDC between networks with Circle."
    >
      {CCTP_ENABLED ? <CctpForm /> : <p>CCTP bridging is not enabled on this deployment.</p>}
    </PageShell>
  )
}
