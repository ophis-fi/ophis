import type { CowEnv, SupportedChainId } from '@cowprotocol/cow-sdk'

import { getEthFlowContractAddresses } from './common'

const ROBINHOOD_CHAIN_ID = 4663 as unknown as SupportedChainId
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

describe('getEthFlowContractAddresses', () => {
  it.each(['prod' as CowEnv, 'staging' as CowEnv])(
    'fails closed for Robinhood before EthFlow deployment in %s',
    (env) => {
      expect(getEthFlowContractAddresses(env, ROBINHOOD_CHAIN_ID)).toBe(ZERO_ADDRESS)
    },
  )
})
