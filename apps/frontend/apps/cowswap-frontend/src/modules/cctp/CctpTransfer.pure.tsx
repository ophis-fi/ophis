import { ReactNode, useState } from 'react'

import { Link } from 'react-router'
import { formatUnits } from 'viem'

import { parameterizeTradeRoute } from 'modules/trade'

import { Routes } from 'common/constants/routes'

import { cctpNetwork } from './cctp.const'
import { type CctpTransfer } from './cctp.service'
import { cctpAsset, cctpToken } from './cctpAssets.const'
import { type CctpStatus } from './cctpStatus.service'
import { type useCctpTransfer } from './useCctpTransfer'

export function CctpHashRecovery({
  label,
  busy,
  onResume,
}: {
  label: string
  busy: boolean
  onResume(hash: string): void
}): ReactNode {
  const [hash, setHash] = useState('')
  return (
    <>
      <label>
        {label}
        <input value={hash} onChange={(event) => setHash(event.target.value.trim())} />
      </label>
      <button type="button" disabled={busy || !hash} onClick={() => onResume(hash)}>
        Resume transfer
      </button>
    </>
  )
}

interface CctpTransferDetailsProps {
  transfer: CctpTransfer
  status: CctpStatus | null
  busy: boolean
  canClaim: boolean
  claimPreparation?: { label: string; action(): void }
  onClaim(): void
  onResume(hash: string): void
  onResumeClaim(hash: string): void
  onFinish(): void
}

export function CctpTransferDetails({
  transfer,
  status,
  busy,
  canClaim,
  claimPreparation,
  onClaim,
  onResume,
  onResumeClaim,
  onFinish,
}: CctpTransferDetailsProps): ReactNode {
  const asset = cctpAsset(transfer.asset)
  const source = cctpNetwork(transfer.source)
  const destination = cctpNetwork(transfer.destination)
  return (
    <>
      <h2>Your {asset.symbol} transfer</h2>
      <p>
        {formatUnits(BigInt(transfer.amount), asset.decimals)} {asset.symbol} · {source.chain.name} →{' '}
        {destination.chain.name}
      </p>
      <p>Recipient: {transfer.owner}</p>
      <p role="status">{status?.text || 'Checking transfer status…'}</p>
      {transfer.burnHash && (
        <a
          href={`${source.chain.blockExplorers?.default.url}/tx/${transfer.burnHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Source transaction
        </a>
      )}
      {!status?.sourceConfirmed && !status?.failed && (
        <>
          <p>
            If your wallet did not return a hash, or you sped up the transaction, paste the confirmed source transaction
            hash below. Do not submit another bridge.
          </p>
          {!transfer.burnHash && transfer.sourceNonce !== undefined && (
            <p>
              Saved source nonce: {transfer.sourceNonce}. If your wallet lost the request without submitting it, cancel
              this nonce on {source.chain.name} in your wallet, then paste its confirmed cancellation hash.
            </p>
          )}
          <CctpHashRecovery label="Source transaction hash" busy={busy} onResume={onResume} />
        </>
      )}
      {status?.mintHash && (
        <a
          href={`${destination.chain.blockExplorers?.default.url}/tx/${status.mintHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Destination transaction
        </a>
      )}
      <CctpClaimDetails
        status={status}
        busy={busy}
        canClaim={canClaim}
        claimPreparation={claimPreparation}
        destinationName={destination.chain.name}
        claimNonce={transfer.claimNonce}
        onClaim={onClaim}
        onResumeClaim={onResumeClaim}
      />
      {status?.completed && (
        <Link
          to={parameterizeTradeRoute(
            {
              chainId: String(transfer.destination),
              inputCurrencyId: cctpToken(transfer.destination, transfer.asset),
              outputCurrencyId: undefined,
              inputCurrencyAmount: undefined,
              outputCurrencyAmount: undefined,
              orderKind: undefined,
            },
            Routes.SWAP,
          )}
          onClick={onFinish}
        >
          Swap on {destination.chain.name}
        </Link>
      )}
      {(status?.completed || status?.failed) && (
        <button type="button" disabled={busy} onClick={onFinish}>
          Start another transfer
        </button>
      )}
    </>
  )
}

function CctpClaimDetails({
  status,
  busy,
  canClaim,
  claimPreparation,
  destinationName,
  claimNonce,
  onClaim,
  onResumeClaim,
}: {
  status: CctpStatus | null
  busy: boolean
  canClaim: boolean
  claimPreparation?: { label: string; action(): void }
  destinationName: string
  claimNonce?: number
  onClaim(): void
  onResumeClaim(hash: string): void
}): ReactNode {
  if (!status?.message || status.completed) return null
  return (
    <>
      <p>
        Circle normally delivers automatically. If delivery stalls, you can claim on {destinationName} using your wallet
        and pay destination gas.
      </p>
      <button
        type="button"
        disabled={busy || (!canClaim && !claimPreparation) || !!status.claimPending}
        onClick={claimPreparation?.action ?? onClaim}
      >
        {claimPreparation?.label ?? `Claim on ${destinationName}`}
      </button>
      {!canClaim && !claimPreparation && <p>Connect the recipient wallet on {destinationName} to claim.</p>}
      <p>
        If you already claimed, sped up or cancelled a claim, paste the confirmed destination transaction hash to
        recover it.
      </p>
      {status.claimPending && claimNonce !== undefined && (
        <p>
          Saved claim nonce: {claimNonce}. If your wallet lost the request without submitting it, cancel this nonce on{' '}
          {destinationName} in your wallet, then paste its confirmed cancellation hash.
        </p>
      )}
      <CctpHashRecovery label="Destination transaction hash" busy={busy} onResume={onResumeClaim} />
    </>
  )
}

export function CctpQuoteDetails({
  flow,
  correctChain,
  source,
}: {
  flow: ReturnType<typeof useCctpTransfer>
  correctChain: boolean
  source: number
}): ReactNode {
  if (!flow.quote) return null
  const asset = cctpAsset(flow.quote.asset)
  const native = cctpNetwork(flow.quote.source).chain.nativeCurrency
  const fee = flow.quote.expanded
    ? { amount: flow.quote.expanded.feeTotalAmount, ...native }
    : { amount: flow.quote.maxFee, ...asset }
  return (
    <>
      <dl>
        <dt>Maximum bridge fee</dt>
        <dd>
          {formatUnits(BigInt(fee.amount), fee.decimals)} {fee.symbol}
        </dd>
        <dt>You receive at least</dt>
        <dd>
          {formatUnits(BigInt(flow.quote.amount) - BigInt(flow.quote.maxFee), asset.decimals)} {asset.symbol}
        </dd>
      </dl>
      <p>Standard transfer. Confirmation can take several minutes. Source network gas is paid separately.</p>
      {!correctChain && <p>Switch your wallet to {cctpNetwork(source).chain.name} to continue.</p>}
      <button
        type="button"
        disabled={!!flow.busy}
        onClick={!correctChain ? () => flow.switchNetwork(source) : flow.approved ? flow.bridge : flow.approve}
      >
        {!correctChain
          ? `Switch to ${cctpNetwork(source).chain.name}`
          : flow.approved
            ? `Bridge ${asset.symbol}`
            : `Approve ${asset.symbol}`}
      </button>
    </>
  )
}
