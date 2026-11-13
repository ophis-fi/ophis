import { BridgeStatus, BridgeStatusResult } from '@cowprotocol/sdk-bridging'

import { RelayApi } from './relayApi.service'

const hash = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/i.test(v)

export function isRelayRecoveryRequired(status: BridgeStatusResult | undefined): boolean {
  return !!status && 'relayRecoveryRequired' in status && status.relayRecoveryRequired === true
}

export async function relayStatus(
  api: RelayApi,
  requestId: string,
): Promise<BridgeStatusResult & { relayRecoveryRequired: boolean }> {
  if (!hash(requestId)) throw new Error('Invalid Relay request id')
  const data = (await api.request(`status?requestId=${requestId}`)) as {
    status: unknown
    inTxHashes?: unknown[]
    txHashes?: unknown[]
    refundFailReason?: unknown
  }
  const depositTxHash = data.inTxHashes?.find(hash)
  const fillTxHash = data.txHashes?.find(hash)
  const status = (() => {
    if (data.status === 'success' && fillTxHash) return BridgeStatus.EXECUTED
    if (data.status === 'refund' && fillTxHash) return BridgeStatus.REFUND
    if (
      ['waiting', 'depositing', 'pending', 'submitted', 'failure'].includes(String(data.status)) &&
      !data.refundFailReason
    )
      return BridgeStatus.IN_PROGRESS
    return BridgeStatus.UNKNOWN
  })()
  return {
    status,
    depositTxHash,
    fillTxHash,
    relayRecoveryRequired: data.status === 'failure' && !!data.refundFailReason,
  }
}
