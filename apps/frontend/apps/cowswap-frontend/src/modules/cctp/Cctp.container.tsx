import { ReactNode, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { PageShell } from 'ophis/ds'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { Web3Status } from 'modules/wallet'

import { CCTP_ENABLED } from 'common/constants/featureFlags'

import { CCTP_NETWORKS } from './cctp.const'
import { isCctpOwner } from './cctp.service'
import * as styledEl from './Cctp.styled'
import { CCTP_ASSETS, supportsCctpAsset, type CctpAsset } from './cctpAssets.const'
import { CctpTransferDetails, CctpQuoteDetails } from './CctpTransfer.pure'
import { useCctpTransfer } from './useCctpTransfer'

function CctpForm(): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const flow = useCctpTransfer()
  const [asset, setAsset] = useState<CctpAsset>('USDC')
  const [source, setSource] = useState(8453)
  const [destination, setDestination] = useState(5042)
  const [amount, setAmount] = useState('')
  const correctChain = chainId === source
  return (
    <styledEl.Card aria-label="CCTP token bridge">
      <Web3Status hideConnectButton />
      {flow.transfer ? (
        <CctpTransferDetails
          transfer={flow.transfer}
          status={flow.status}
          busy={!!flow.busy}
          canClaim={chainId === flow.transfer.destination && isCctpOwner(flow.transfer.owner, account)}
          onClaim={flow.claim}
          onResume={flow.resume}
          onResumeClaim={flow.resumeClaim}
          onFinish={flow.finish}
        />
      ) : (
        <>
          <CctpAssetSelect
            value={asset}
            busy={!!flow.busy}
            onChange={(selected) => {
              setAsset(selected)
              if (!supportsCctpAsset(source, selected)) setSource(1)
              if (!supportsCctpAsset(destination, selected)) setDestination(5042)
              setAmount('')
              flow.clearQuote()
            }}
          />
          <CctpNetworkSelect
            label="From"
            value={source}
            asset={asset}
            busy={!!flow.busy}
            onChange={(id) => {
              setSource(id)
              flow.clearQuote()
            }}
          />
          <CctpNetworkSelect
            label="To"
            value={destination}
            asset={asset}
            busy={!!flow.busy}
            onChange={(id) => {
              setDestination(id)
              flow.clearQuote()
            }}
          />
          <label>
            {asset} amount
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
            For personal wallets only. {asset} arrives at the same address on the destination network.{' '}
            {asset === 'USDC'
              ? 'Circle’s forwarding fee is deducted from the amount.'
              : 'Circle’s bridge fee is paid separately in the source network’s native currency.'}
          </p>
          {account ? (
            <button
              type="button"
              disabled={!!flow.busy || source === destination || !amount}
              onClick={() => flow.loadQuote(source, destination, amount, asset)}
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

function CctpAssetSelect({
  value,
  busy,
  onChange,
}: {
  value: CctpAsset
  busy: boolean
  onChange(asset: CctpAsset): void
}): ReactNode {
  return (
    <label>
      Asset
      <select
        value={value}
        disabled={busy}
        onChange={(event) => {
          const selected = CCTP_ASSETS.find((item) => item === event.target.value)
          if (selected) onChange(selected)
        }}
      >
        {CCTP_ASSETS.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
    </label>
  )
}

function CctpNetworkSelect({
  label,
  value,
  asset,
  busy,
  onChange,
}: {
  label: string
  value: number
  asset: CctpAsset
  busy: boolean
  onChange(id: number): void
}): ReactNode {
  return (
    <label>
      {label}
      <select value={value} disabled={busy} onChange={(event) => onChange(Number(event.target.value))}>
        {CCTP_NETWORKS.filter(({ chain }) => supportsCctpAsset(chain.id, asset)).map(({ chain }) => (
          <option key={chain.id} value={chain.id}>
            {chain.name}
          </option>
        ))}
      </select>
    </label>
  )
}

export function CctpPage(): ReactNode {
  return (
    <PageShell
      width="medium"
      eyebrow="Circle CCTP"
      title="Bridge tokens"
      lede="Transfer native USDC, EURC, and cirBTC between networks with Circle."
    >
      {CCTP_ENABLED ? <CctpForm /> : <p>CCTP bridging is not enabled on this deployment.</p>}
    </PageShell>
  )
}
