import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { solanaConnectionAtom } from 'entities/solana'

import { privateAction } from '../services/privateSettlement.service'
import { nativeSolanaFormAtom, privateUsdcToSol } from '../state/trade.atoms'

const payer = '63oxKoqF8skx14fGcbNfhrKtanKPHg6X6NyUw4qPirnA'
const operator = 'HaHANqyW2wVYw4qUGougZkSqYv6VgfA4DLX1bXx7PAZr'
interface Funding {
  address: string
  amount?: number
  fee?: number
  wire?: string
  balance: number
}

export function PrivateOperatorFunding({ nativePayout, forWsol = false }: { nativePayout: boolean; forWsol?: boolean }): ReactNode {
  const connection = useAtomValue(solanaConnectionAtom)
  const setForm = useSetAtom(nativeSolanaFormAtom)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const amount = forWsol ? 660_000 : 3_000_000
  const pendingKey = forWsol ? 'ophis-private-wsol-funding-pending' : 'ophis-private-solver-funding-pending'
  async function fund(): Promise<void> {
    if (busy || connection?.account.address !== payer) return
    setBusy(true)
    try {
      const result = await privateAction<Funding>('fund-operator', forWsol ? { purpose: 'wsol-rent' } : {})
      if (result.address !== operator) throw Error('Unexpected solver wallet.')
      if (!result.wire && result.balance > 0) {
        setStatus('The solver is funded. Get a fresh quote.')
        return
      }
      if (result.amount !== amount || result.fee !== 5000 || !result.wire) throw Error('Funding terms changed.')
      const feature = connection.wallet.features['solana:signAndSendTransaction']
      if (!feature) throw Error('Reconnect Backpack to fund the solver.')
      if (sessionStorage.getItem(pendingKey))
        throw Error('Funding was submitted. Check Backpack activity before another transfer.')
      const [sent] = await feature.signAndSendTransaction({
        account: connection.account,
        chain: 'solana:mainnet',
        transaction: Uint8Array.from(atob(result.wire), (c) => c.charCodeAt(0)),
        options: { preflightCommitment: 'confirmed' },
      })
      if (!sent?.signature) throw Error('Check the funding transaction in Backpack.')
      sessionStorage.setItem(pendingKey, '1')
      setStatus('Funding submitted. Once confirmed, get a fresh quote.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Check funding in Backpack.')
    } finally {
      setBusy(false)
    }
  }
  if (nativePayout)
    return (
      <ButtonSecondary type="button" onClick={() => setForm(privateUsdcToSol)}>
        Use 0.10 USDC for SOL
      </ButtonSecondary>
    )
  function selectTrade(): void {
    setForm({
      sellMint: 'So11111111111111111111111111111111111111112',
      buyMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: '0.001',
      slippageBps: 50,
    })
  }
  return (
    <section aria-label="Automatic settlement test">
      <p>
        Solver funding sends {forWsol ? '0.00066' : '0.003'} SOL to <code>{operator}</code>. The funding transaction fee is 0.000005 SOL.
      </p>
      <ButtonSecondary
        type="button"
        disabled={busy || connection?.account.address !== payer}
        onClick={() => void fund()}
      >
        Review solver funding in Backpack
      </ButtonSecondary>
      {!forWsol && (
        <ButtonSecondary type="button" onClick={() => selectTrade()}>
          Use 0.001 wSOL for USDC
        </ButtonSecondary>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  )
}
