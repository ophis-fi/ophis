import type { CowEnv, SupportedChainId } from '@cowprotocol/cow-sdk'

import { getEthFlowContractAddresses } from './common'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const ROBINHOOD_ETH_FLOW = '0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29'

describe('getEthFlowContractAddresses', () => {
  it.each(['prod' as CowEnv, 'staging' as CowEnv])(
    'uses the deployed Robinhood EthFlow in %s',
    (env) => {
      expect(getEthFlowContractAddresses(env, ROBINHOOD_CHAIN_ID)).toBe(ROBINHOOD_ETH_FLOW)
    },
  )
})
