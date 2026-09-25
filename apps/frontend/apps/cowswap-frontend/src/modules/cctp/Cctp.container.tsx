import { ReactNode, useState } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { PageShell } from 'ophis/ds'
import { Link, useLocation } from 'react-router'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { parameterizeTradeRoute } from 'modules/trade'
import { Web3Status } from 'modules/wallet'

import { CCTP_ENABLED } from 'common/constants/featureFlags'
import { Routes } from 'common/constants/routes'

import { CCTP_NETWORKS, cctpNetwork } from './cctp.const'
import { isCctpOwner } from './cctp.service'
import * as styledEl from './Cctp.styled'
import { CCTP_ASSETS, cctpToken, cctpAssetRoute, supportsCctpAsset, type CctpAsset } from './cctpAssets.const'
import { cctpInitialSelection } from './cctpRoute.utils'
import { CctpTransferDetails, CctpQuoteDetails } from './CctpTransfer.pure'
import { useCctpTransfer } from './useCctpTransfer'

function CctpForm(): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const flow = useCctpTransfer()
  const { search } = useLocation()
  const [initial] = useState(() => cctpInitialSelection(search, chainId))
  const [asset, setAsset] = useState<CctpAsset>(initial.asset)
  const [source, setSource] = useState(initial.source)
  const [destination, setDestination] = useState(initial.destination)
  const [amount, setAmount] = useState('')
  return (
    <styledEl.Card aria-label="CCTP token bridge">
      <Web3Status hideConnectButton />
      {flow.transfer ? (
        <CctpPendingTransfer flow={flow} />
      ) : (
        <>
          {asset === initial.asset && source === initial.source && <CctpSwapFirst initial={initial} />}
          <CctpAssetSelect
            value={asset}
            busy={!!flow.busy}
            onChange={(selected) => {
              setAsset(selected)
              const next = cctpAssetRoute(selected, source, destination)
              setSource(next.source)
              setDestination(next.destination)
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
          {asset.endsWith('on') && (
            <p>Tokenized securities may require issuer eligibility on the destination network.</p>
          )}
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
          {flow.quote && <CctpQuoteDetails flow={flow} correctChain={chainId === source} source={source} />}
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

function CctpSwapFirst({ initial }: { initial: ReturnType<typeof cctpInitialSelection> }): ReactNode {
  return (
    <>
      {initial.swapFirstToken && (
        <p>
          This token has no direct CCTP route.{' '}
          <Link
            to={parameterizeTradeRoute(
              {
                chainId: String(initial.source),
                inputCurrencyId: initial.swapFirstToken,
                outputCurrencyId: cctpToken(initial.source),
                inputCurrencyAmount: undefined,
                outputCurrencyAmount: undefined,
                orderKind: undefined,
              },
              Routes.SWAP,
            )}
          >
            Swap it to USDC
          </Link>
          , then return here to bridge the USDC. Each step needs your confirmation.
        </p>
      )}
    </>
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
      lede="Transfer USDC, EURC, cirBTC, WETH and supported tokens between networks with Circle CCTP."
    >
      {CCTP_ENABLED ? <CctpForm /> : <p>CCTP bridging is not enabled on this deployment.</p>}
    </PageShell>
  )
}
