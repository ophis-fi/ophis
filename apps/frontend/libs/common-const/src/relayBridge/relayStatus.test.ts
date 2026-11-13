import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { RelayApi } from './relayApi.service'
import { isRelayRecoveryRequired, isRelayStatus, relayStatus } from './relayStatus.service'

const REQUEST_ID = `0x${'11'.repeat(32)}`
const FILL_TX = `0x${'22'.repeat(32)}`

it.each([
  ['success', BridgeStatus.EXECUTED],
  ['refund', BridgeStatus.REFUND],
])('identifies Relay %s without inventing delivered or refunded amounts', async (status, expected) => {
  const api = new RelayApi()
  jest.spyOn(api, 'request').mockResolvedValue({ status, txHashes: [FILL_TX] })
  const result = await relayStatus(api, REQUEST_ID)
  expect(result.status).toBe(expected)
  expect(isRelayStatus(result)).toBe(true)
  expect(isRelayRecoveryRequired(result)).toBe(false)
  expect(result).not.toHaveProperty('outputAmount')
})

it('does not identify other providers or missing status as Relay', () => {
  expect(isRelayStatus(undefined)).toBe(false)
  expect(isRelayStatus({ status: BridgeStatus.EXECUTED })).toBe(false)
})
