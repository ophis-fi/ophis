import { withTimeout } from '@cowprotocol/common-utils'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'

import type { OtcReaderClient } from 'ophis/otc'

const MAX_HEAD_AGE_SECONDS = 120n
const MAX_HEAD_LAG_BLOCKS = 2n

async function verifyNetwork(connected: OtcReaderClient, canonical: OtcReaderClient): Promise<void> {
  const chains = await Promise.all([connected.getChainId(), canonical.getChainId()])
  if (chains.some((chain) => chain !== OPHIS_ETHEREUM_OTC_MANIFEST.chainId)) {
    throw new Error('Ophis OTC wrong chain')
  }
  const head = await connected.getLatestBlock()
  const [reference, latest] = await Promise.all([canonical.getBlockByNumber(head.number), canonical.getLatestBlock()])
  const now = BigInt(Math.floor(Date.now() / 1_000))
  if (
    !head.hash ||
    reference.hash !== head.hash ||
    reference.number !== head.number ||
    reference.timestamp !== head.timestamp ||
    head.number > latest.number ||
    latest.number - head.number > MAX_HEAD_LAG_BLOCKS ||
    head.timestamp > now + 30n ||
    now - head.timestamp > MAX_HEAD_AGE_SECONDS
  ) {
    throw new Error('Ophis OTC wallet state does not match current Ethereum')
  }
}

/** Cross-check the wallet transport against Ophis's independent mainnet reader; receipt reads use that reader too. */
export function verifyOtcCanaryNetwork(connected: OtcReaderClient, canonical: OtcReaderClient): Promise<void> {
  return withTimeout(
    verifyNetwork(connected, canonical),
    OPHIS_ETHEREUM_OTC_MANIFEST.readTimeoutMs,
    'Ophis OTC Ethereum verification timed out',
  )
}
