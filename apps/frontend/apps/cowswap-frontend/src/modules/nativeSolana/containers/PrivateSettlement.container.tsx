import { useAtomValue } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import { ButtonPrimary } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import {
  fetchOphisSolanaMint,
  formatOphisSolanaAmount,
  SOLANA_NATIVE_ASSET,
  WRAPPED_SOL_MINT,
  solanaAddress,
} from '@ophis/solana-sdk'
import { OPHIS_SOLANA_CONFIG, solanaConnectionAtom } from 'entities/solana'

import { shortMint } from '../services/assets.service'
import { privateAction, type PrivateSettlement } from '../services/privateSettlement.service'
import { walletAssetListAtom } from '../state/assets.atoms'
import { type SavedNativeSolanaOrder } from '../state/orders.atoms'

interface SettlementView {
  result: PrivateSettlement
  unit: { decimals: number; label: string }
  busy: boolean
  error: string
  act(): Promise<void>
}

function usePrivateSettlement(order: SavedNativeSolanaOrder): SettlementView {
  const connection = useAtomValue(solanaConnectionAtom)
  const assets = useAtomValue(walletAssetListAtom)
  const [result, setResult] = useState<PrivateSettlement>({ state: 'ready' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [unit, setUnit] = useState({ decimals: 0, label: '' })
  const uid = order.uid
  const pending = result.state === 'pending'
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout>
    async function check(): Promise<void> {
      try {
        const status = await privateAction<PrivateSettlement>('status', { uid })
        if (!live) return
        if (status.state !== 'ready') setResult(status)
        if (status.state === 'pending') timer = setTimeout(check, 5000)
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not check the settlement.')
      }
    }
    void check()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [uid, pending])
  useEffect(() => {
    if (result.state !== 'review') return
    const timer = setTimeout(
      () => {
        setResult({ state: 'ready' })
        setError('Settlement preview expired. Review the current route again.')
      },
      Math.max(0, result.deadline - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [result])
  async function act(): Promise<void> {
    if (!connection || !OPHIS_SOLANA_CONFIG || busy) return
    setBusy(true)
    setError('')
    try {
      if (result.state !== 'review') {
        const next = await privateAction<PrivateSettlement>('prepare', { uid, pda: order.orderPda })
        if (next.state === 'review') {
          const native = next.buyMint === SOLANA_NATIVE_ASSET
          const decimals =
            native || next.buyMint === WRAPPED_SOL_MINT
              ? 9
              : (await fetchOphisSolanaMint(OPHIS_SOLANA_CONFIG.api, solanaAddress(next.buyMint))).decimals
          setUnit({
            decimals,
            label: native ? 'SOL' : (assets.find((a) => a.mint === next.buyMint)?.symbol ?? shortMint(next.buyMint)),
          })
        }
        setResult(next)
      } else {
        const signing = connection.wallet.features['solana:signTransaction']
        if (!signing?.supportedTransactionVersions.includes(0))
          throw Error('This private test needs a wallet that signs Solana v0 transactions.')
        const { wire } = await privateAction<{ wire: string }>('wire', { uid, deadline: result.deadline })
        const transaction = Uint8Array.from(atob(wire), (c) => c.charCodeAt(0))
        const [signed] = await signing.signTransaction({
          account: connection.account,
          chain: 'solana:mainnet',
          transaction,
          options: { preflightCommitment: 'confirmed' },
        })
        if (!signed?.signedTransaction) throw Error('The wallet did not sign the settlement.')
        setResult(
          await privateAction<PrivateSettlement>('signed', {
            uid,
            wire: btoa(String.fromCharCode(...signed.signedTransaction)),
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare this settlement.')
      if (result.state === 'review') {
        await privateAction('decline', { uid }).catch(() => undefined)
        setResult({ state: 'ready' })
      }
    } finally {
      setBusy(false)
    }
  }
  return { result, error, unit, busy, act }
}

export function PrivateSettlementPanel({ order }: { order: SavedNativeSolanaOrder }): ReactNode {
  const { result, error, unit, busy, act } = usePrivateSettlement(order)
  const waiting = result.state === 'pending',
    confirmed = result.state === 'confirmed'
  return (
    <div>
      {result.state === 'review' && (
        <dl>
          <dt>
            <Trans>Route</Trans>
          </dt>
          <dd>{result.venue}</dd>
          <dt>
            <Trans>Simulated receipt</Trans>
          </dt>
          <dd>
            {formatOphisSolanaAmount(BigInt(result.received), unit.decimals)} {unit.label}
          </dd>
          <dt>
            <Trans>Minimum received</Trans>
          </dt>
          <dd>
            {formatOphisSolanaAmount(BigInt(result.minimum), unit.decimals)} {unit.label}
          </dd>
          <dt>
            <Trans>Network fee</Trans>
          </dt>
          <dd>{formatOphisSolanaAmount(BigInt(result.fee), 9)} SOL</dd>
          <dt>
            <Trans>New account deposits</Trans>
          </dt>
          <dd>{formatOphisSolanaAmount(BigInt(result.deposits), 9)} SOL</dd>
        </dl>
      )}
      {'signature' in result && (
        <a href={'https://explorer.solana.com/tx/' + result.signature} target="_blank" rel="noreferrer">
          {confirmed ? (
            <Trans>Finalized settlement</Trans>
          ) : waiting ? (
            <Trans>Checking settlement on mainnet</Trans>
          ) : (
            <Trans>Previous settlement attempt</Trans>
          )}
        </a>
      )}
      {error && <p role="alert">{error}</p>}
      {!waiting && !confirmed && (
        <ButtonPrimary type="button" disabled={busy} onClick={() => void act()}>
          {busy ? (
            <Trans>Preparing settlement…</Trans>
          ) : result.state === 'review' ? (
            <Trans>Settle in Backpack</Trans>
          ) : (
            <Trans>Review settlement</Trans>
          )}
        </ButtonPrimary>
      )}
    </div>
  )
}
