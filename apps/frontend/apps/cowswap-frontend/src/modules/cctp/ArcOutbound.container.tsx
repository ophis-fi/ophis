import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import {
  ARC_CHAIN_ID,
  RELAY_ENABLED,
  RelayBridgeProvider,
  getAcrossV5Status,
  getChainInfo,
  isRelayRecoveryRequired,
} from '@cowprotocol/common-const'
import { isRejectRequestProviderError } from '@cowprotocol/common-utils'
import { type SupportedChainId } from '@cowprotocol/cow-sdk'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'
import { useWalletInfo } from '@cowprotocol/wallet'

import { arcDestinationUsdc, cctpNetwork } from 'entities/cctp'
import { formatUnits, getAddress, type Address, type Hex } from 'viem'
import { z } from 'zod'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import {
  type ArcBridgeProvider,
  type ArcDeposit,
  arcAllowance,
  quoteArcDeposit,
  sendArcDeposit,
} from './arcOutbound.service'
import { cctpClient } from './cctp.service'
import { Card } from './Cctp.styled'
import { switchCctpChain } from './cctpWallet.service'
import { useCctpWallet } from './useCctpWallet'

const receiptSchema = z.object({
  provider: z.enum(['Across', 'Relay']),
  id: z.string().regex(/^0x[0-9a-f]{64}$/i),
  destination: z.number().int().positive(),
  minimum: z.string().regex(/^[1-9]\d{0,77}$/),
  nonce: z.number().int().nonnegative(),
  hash: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/i)
    .optional(),
})
type Receipt = z.infer<typeof receiptSchema>
const relay = new RelayBridgeProvider()
const storageKey = (owner: string): string => 'ophisArcBridge:' + owner.toLowerCase()
function subscribe(listener: () => void): () => void {
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
function save(key: string, record: Receipt | null): void {
  if (record) localStorage.setItem(key, JSON.stringify(record))
  else localStorage.removeItem(key)
  window.dispatchEvent(new Event('storage'))
}
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
  assertCurrent: () => void,
  approvalDone: () => Promise<void>,
): Promise<void> {
  const { owner: account, destination, provider } = quote
  const key = storageKey(account)
  if (!navigator.locks) throw new Error('Use a browser with Web Locks to bridge.')
  await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
    if (!lock || localStorage.getItem(key)) throw new Error('Check the pending Arc bridge before starting another.')
    let record: Receipt | undefined
    const hash = await sendArcDeposit(wallet, quote, !approved, assertCurrent, (nonce) => {
      record = { provider, id: quote.id, destination, minimum: String(quote.minimum), nonce }
      save(key, record)
    }).catch((e: unknown) => {
      if (record && isRejectRequestProviderError(e)) save(key, null)
      throw e
    })
    if (record) save(key, { ...record, hash })
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
                    await submit(quote, wallet, approved, assertCurrent, review)
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

interface DeliveryStatus {
  text: string
  done?: boolean
}

function matchesDelivery(
  delivery: Awaited<ReturnType<typeof getAcrossV5Status>>['destination'],
  record: Receipt,
  account: Address,
): boolean {
  return (
    !!delivery &&
    delivery.chainId === record.destination &&
    delivery.token.toLowerCase() === arcDestinationUsdc(record.destination)?.address.toLowerCase() &&
    delivery.recipient.toLowerCase() === account.toLowerCase() &&
    BigInt(delivery.amount) >= BigInt(record.minimum)
  )
}

async function deliveryStatus(record: Receipt, account: Address): Promise<DeliveryStatus> {
  if (record.hash) {
    const receipt = await cctpClient(ARC_CHAIN_ID)
      .getTransactionReceipt({ hash: record.hash as Hex })
      .catch(() => null)
    if (receipt?.status === 'reverted') return { text: 'The Arc deposit reverted.', done: true }
  }
  const across = record.provider === 'Across' ? await getAcrossV5Status(record.id) : undefined
  const result = across ?? (await relay.getStatus(record.id, ARC_CHAIN_ID))
  if (isRelayRecoveryRequired(result)) return { text: 'Open Relay to recover this transfer.', done: true }
  if (record.hash && result.depositTxHash && record.hash.toLowerCase() !== result.depositTxHash.toLowerCase())
    return { text: 'Deposit hash mismatch. Check the transfer with the provider.' }
  if (result.status === BridgeStatus.EXECUTED && result.fillTxHash) {
    if (across && !matchesDelivery(across.destination, record, account))
      return { text: 'Waiting for matching delivery details.' }
    return { text: 'Provider confirmed delivery.', done: true }
  }
  if (result.status === BridgeStatus.REFUND && result.fillTxHash)
    return { text: 'Provider reported a refund.', done: true }
  return { text: 'Delivery has not been confirmed.' }
}

export function ArcOutboundRecovery(): ReactNode {
  const { account } = useWalletInfo()
  const key = account ? storageKey(account) : ''
  const getSnapshot = useCallback(() => {
    try {
      return key ? localStorage.getItem(key) : null
    } catch {
      return null
    }
  }, [key])
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => null)
  const record = useMemo(() => {
    if (!raw) return null
    try {
      return receiptSchema.parse(JSON.parse(raw))
    } catch {
      return null
    }
  }, [raw])
  if (!raw || !account) return null
  return (
    <Card aria-label="Saved Arc bridge">
      {record && arcDestinationUsdc(record.destination) ? (
        <ArcReceipt key={raw} record={record} owner={getAddress(account)} />
      ) : (
        <p role="alert">Saved Arc bridge details could not be read. Check your wallet history.</p>
      )}
      <DismissTracking key={raw + key} storage={key} saved={raw} />
    </Card>
  )
}

function DismissTracking({ storage, saved }: { storage: string; saved: string }): ReactNode {
  const [confirm, setConfirm] = useState(false)
  async function dismiss(): Promise<void> {
    await navigator.locks.request(storage, { ifAvailable: true }, (lock) => {
      if (lock && localStorage.getItem(storage) === saved) save(storage, null)
    })
  }
  return (
    <>
      {confirm && (
        <p>
          Check your wallet history first. Clearing this record removes tracking and leaves any transfer in progress.
        </p>
      )}
      <button disabled={!navigator.locks} onClick={() => (confirm ? void dismiss() : setConfirm(true))}>
        {confirm ? 'Clear saved record' : 'Dismiss tracking'}
      </button>
    </>
  )
}

function ArcReceipt({ record, owner }: { record: Receipt; owner: Address }): ReactNode {
  const [status, setStatus] = useState('Checking delivery…')
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    async function update(): Promise<void> {
      let next: DeliveryStatus
      try {
        next = await deliveryStatus(record, owner)
      } catch {
        next = { text: 'Provider status is temporarily unavailable.' }
      }
      if (!active) return
      setStatus(next.text)
      if (!next.done) timer = setTimeout(() => void update(), 30_000)
    }
    void update()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [record, owner])
  return (
    <>
      <p>
        {record.provider} transfer to {getChainInfo(record.destination as SupportedChainId).label}. {status}
      </p>
      <p>Transfer ID {record.id}</p>
      {record.provider === 'Relay' && <a href={relay.getExplorerUrl(record.id)}>Track on Relay</a>}
      {record.hash ? (
        <a href={cctpNetwork(ARC_CHAIN_ID).chain.blockExplorers?.default.url + '/tx/' + record.hash}>
          View Arc transaction
        </a>
      ) : (
        <p>Check wallet activity for Arc transaction nonce {record.nonce} before trying again.</p>
      )}
    </>
  )
}
