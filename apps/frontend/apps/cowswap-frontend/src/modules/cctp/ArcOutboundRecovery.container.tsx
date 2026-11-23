import { useAtomValue, useSetAtom } from 'jotai'
import { type ReactNode, useMemo, useState } from 'react'

import {
  ARC_CHAIN_ID,
  RelayBridgeProvider,
  getAcrossV5Status,
  getChainInfo,
  isRelayRecoveryRequired,
} from '@cowprotocol/common-const'
import { areAddressesEqual, type SupportedChainId } from '@cowprotocol/cow-sdk'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'
import { useWalletInfo } from '@cowprotocol/wallet'

import { arcDestinationUsdc, cctpNetwork } from 'entities/cctp'
import { atomWithQuery } from 'jotai-tanstack-query'
import { getAddress, type Address, type Hex } from 'viem'

import { arcReceiptAtom, arcReceiptKey, readArcReceipt, receiptSchema, type Receipt } from './arcReceipt.atoms'
import { cctpClient } from './cctp.service'
import * as styledEl from './Cctp.styled'

const relay = new RelayBridgeProvider()
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
    areAddressesEqual(delivery.token, arcDestinationUsdc(record.destination)?.address) &&
    areAddressesEqual(delivery.recipient, account) &&
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
  const owner = account || ''
  const raw = useAtomValue(arcReceiptAtom(owner))
  const record = useMemo(() => receiptSchema.safeParse(raw).data, [raw])
  if (raw === null || !account) return null
  return (
    <styledEl.Card aria-label="Saved Arc bridge">
      {record && arcDestinationUsdc(record.destination) ? (
        <ArcReceipt key={JSON.stringify(raw)} record={record} owner={getAddress(account)} />
      ) : (
        <p role="alert">Saved Arc bridge details could not be read. Check your wallet history.</p>
      )}
      <DismissTracking key={JSON.stringify([owner, raw])} owner={owner} saved={raw} />
    </styledEl.Card>
  )
}

function DismissTracking({ owner, saved }: { owner: string; saved: unknown }): ReactNode {
  const [confirm, setConfirm] = useState(false)
  const setRecord = useSetAtom(arcReceiptAtom(owner))
  const storage = arcReceiptKey(owner)
  async function dismiss(): Promise<void> {
    await navigator.locks.request(storage, { ifAvailable: true }, (lock) => {
      if (lock && JSON.stringify(readArcReceipt(storage)) === JSON.stringify(saved)) setRecord(null)
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
  const statusAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['arcBridgeDelivery', owner, record],
        queryFn: () => deliveryStatus(record, owner),
        refetchInterval: (query) => (query.state.data?.done ? false : 30_000),
        refetchOnWindowFocus: false,
        retry: false,
      })),
    [owner, record],
  )
  const { data, isError } = useAtomValue(statusAtom)
  const status = data?.text ?? (isError ? 'Provider status is temporarily unavailable.' : 'Checking delivery…')
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
