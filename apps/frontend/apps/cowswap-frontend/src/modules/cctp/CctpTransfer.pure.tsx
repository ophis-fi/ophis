import { ReactNode, useState } from 'react'

import { formatUnits } from 'viem'

import { cctpNetwork } from './cctp.const'
import { type CctpTransfer } from './cctp.service'
import { type CctpStatus } from './cctpStatus.service'
import { type useCctpTransfer } from './useCctpTransfer'

export function CctpTransferDetails({
  transfer,
  status,
  busy,
  canClaim,
  onClaim,
  onResume,
  onFinish,
}: {
  transfer: CctpTransfer
  status: CctpStatus | null
  busy: boolean
  canClaim: boolean
  onClaim(): void
  onResume(hash: string): void
  onFinish(): void
}): ReactNode {
  const [hash, setHash] = useState('')
  const source = cctpNetwork(transfer.source)
  const destination = cctpNetwork(transfer.destination)
  return (
    <>
      <h2>Your USDC transfer</h2>
      <p>
        {formatUnits(BigInt(transfer.amount), 6)} USDC · {source.chain.name} → {destination.chain.name}
      </p>
      <p>Recipient: {transfer.owner}</p>
      <p role="status">{status?.text || 'Checking transfer status…'}</p>
      {transfer.burnHash ? (
        <a
          href={`${source.chain.blockExplorers?.default.url}/tx/${transfer.burnHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Source transaction
        </a>
      ) : (
        <>
          <p>
            If the wallet submitted your bridge but did not return its hash, paste the source transaction hash below. Do
            not submit another bridge.
          </p>
          <label>
            Source transaction hash
            <input value={hash} onChange={(event) => setHash(event.target.value.trim())} />
          </label>
          <button type="button" disabled={busy || !hash} onClick={() => onResume(hash)}>
            Resume transfer
          </button>
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
      {status?.message && !status.completed && (
        <>
          <p>
            Circle normally delivers automatically. If delivery stalls, you can claim on {destination.chain.name} using
            your wallet and pay destination gas.
          </p>
          <button type="button" disabled={busy || !canClaim || !!status.mintHash} onClick={onClaim}>
            Claim on {destination.chain.name}
          </button>
          {!canClaim && <p>Connect the recipient wallet on {destination.chain.name} to claim.</p>}
        </>
      )}
      {(status?.completed || status?.failed) && (
        <button type="button" disabled={busy} onClick={onFinish}>
          Start another transfer
        </button>
      )}
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
  return (
    <>
      <dl>
        <dt>Maximum bridge fee</dt>
        <dd>{formatUnits(BigInt(flow.quote.maxFee), 6)} USDC</dd>
        <dt>You receive at least</dt>
        <dd>{formatUnits(BigInt(flow.quote.amount) - BigInt(flow.quote.maxFee), 6)} USDC</dd>
      </dl>
      <p>Standard transfer. Confirmation can take several minutes. Source network gas is paid separately.</p>
      {!correctChain && <p>Switch your wallet to {cctpNetwork(source).chain.name} to continue.</p>}
      <button
        type="button"
        disabled={!!flow.busy}
        onClick={!correctChain ? () => flow.switchNetwork(source) : flow.approved ? flow.bridge : flow.approve}
      >
        {!correctChain ? `Switch to ${cctpNetwork(source).chain.name}` : flow.approved ? 'Bridge USDC' : 'Approve USDC'}
      </button>
    </>
  )
}
