import { useStore } from 'jotai'
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'

import { ARC_CHAIN_ID, RELAY_ENABLED, getChainInfo } from '@cowprotocol/common-const'
import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import { type SupportedChainId } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { formatUnits, getAddress } from 'viem'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import {
  type ArcBridgeProvider,
  type ArcDeposit,
  arcAllowance,
  quoteArcDeposit,
  sendArcDeposit,
} from './arcOutbound.service'
import { arcReceiptAtom, arcReceiptKey, readArcReceipt, type Receipt } from './arcReceipt.atoms'
import { cctpClient } from './cctp.service'
import { Card } from './Cctp.styled'
import { switchCctpChain } from './cctpWallet.service'
import { useCctpWallet } from './useCctpWallet'

function displayError(error: unknown): string {
  return error instanceof Error ? error.message : 'The bridge request failed.'
}
export function ArcBridgeSelector({
  value,
  circle,
  onChange,
}: {
  value: ArcBridgeProvider | 'Circle'
  circle: boolean
  onChange: (value: ArcBridgeProvider | 'Circle') => void
}): ReactNode {
  return (
    <Card>
      <label>
        Bridge provider
        <select value={value} onChange={(event) => onChange(event.target.value as typeof value)}>
          {circle && <option>Circle</option>}
          <option>Across</option>
          {RELAY_ENABLED && <option>Relay</option>}
        </select>
      </label>
    </Card>
  )
}
async function submit(
  quote: ArcDeposit,
  wallet: NonNullable<ReturnType<typeof useCctpWallet>>,
  approved: boolean,
  store: ReturnType<typeof useStore>,
  assertCurrent: () => void,
  approvalDone: () => Promise<void>,
): Promise<void> {
  const { owner: account, destination, provider } = quote
  const key = arcReceiptKey(account)
  const atom = arcReceiptAtom(account)
  if (!navigator.locks) throw new Error('Use a browser with Web Locks to bridge.')
  await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
    if (!lock || readArcReceipt(key) !== null) throw new Error('Check the pending Arc bridge before starting another.')
    let record: Receipt | undefined
    const hash = await sendArcDeposit(wallet, quote, !approved, assertCurrent, (nonce) => {
      record = { provider, id: quote.id, destination, minimum: String(quote.minimum), nonce }
      store.set(atom, record)
    }).catch((e: unknown) => {
      if (record && isRejectRequestProviderError(e)) store.set(atom, null)
      throw e
    })
    if (record) store.set(atom, { ...record, hash })
    if (!approved) {
      const receipt = await cctpClient(ARC_CHAIN_ID).waitForTransactionReceipt({ hash, timeout: 120_000 })
      if (receipt.status !== 'success') throw new Error('USDC approval reverted.')
      assertCurrent()
      await approvalDone()
    }
  })
}
export function ArcOutboundForm({
  provider,
  destination,
  amount,
}: {
  provider: ArcBridgeProvider
  destination: number
  amount: bigint | undefined
}): ReactNode {
  const { account, chainId } = useWalletInfo()
  const connect = useToggleWalletModal()
  const wallet = useCctpWallet()
  const store = useStore()
  const [quote, setQuote] = useState<ArcDeposit>()
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inFlight = useRef(false)
  const active = useRef(false)
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const assertCurrent = (): void => {
    if (!active.current) throw new Error('Bridge details changed. Review a fresh quote.')
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(displayError(e))
      setQuote(undefined)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  async function review(): Promise<void> {
    if (!account || !amount) return
    setQuote(undefined)
    const next = await quoteArcDeposit(provider, getAddress(account), destination, amount)
    const allowed = await arcAllowance(next)
    assertCurrent()
    setApproved(allowed >= next.amount)
    setQuote(next)
  }
  if (!account) return <button onClick={connect}>Connect wallet</button>
  return (
    <Card aria-label="Arc bridge quote">
      {chainId !== ARC_CHAIN_ID ? (
        <button
          disabled={busy || !wallet}
          onClick={() => wallet && void run(() => switchCctpChain(wallet, ARC_CHAIN_ID))}
        >
          Switch to Arc
        </button>
      ) : (
        <>
          <button disabled={busy || !amount || !wallet} onClick={() => void run(review)}>
            {quote ? 'Refresh quote' : 'Get ' + provider + ' quote'}
          </button>
          {quote && (
            <>
              <p>
                Send {formatUnits(quote.amount, 6)} USDC on Arc. Receive about {formatUnits(quote.expected, 6)} USDC on{' '}
                {getChainInfo(destination as SupportedChainId).label}. Minimum {formatUnits(quote.minimum, 6)} USDC. Arc
                gas is paid separately.
              </p>
              <p>Deliver to {quote.owner}</p>
              <button
                disabled={busy}
                onClick={() =>
                  wallet &&
                  void run(async () => {
                    await submit(quote, wallet, approved, store, assertCurrent, review)
                    if (approved) setQuote(undefined)
                  })
                }
              >
                {approved ? 'Bridge with ' + provider : 'Approve ' + formatUnits(quote.amount, 6) + ' USDC'}
              </button>
            </>
          )}
        </>
      )}
      {busy && <p role="status">Waiting for the bridge or wallet…</p>}
      {error && <p role="alert">{error}</p>}
    </Card>
  )
}
