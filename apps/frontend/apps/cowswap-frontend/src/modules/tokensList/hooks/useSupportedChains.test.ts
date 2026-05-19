import { CHAIN_INFO } from '@cowprotocol/common-const'
import { ChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'
import { useFlags } from 'launchdarkly-react-client-sdk'

import { useSupportedChains } from './useSupportedChains'

import { mapChainInfo } from '../utils/mapChainInfo'

jest.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: jest.fn(),
}))

jest.mock('../utils/mapChainInfo', () => ({
  mapChainInfo: jest.fn((id: number) => ({ id, label: `Chain ${id}` }) as unknown as ChainInfo),
}))

const mockUseFlags = useFlags as jest.MockedFunction<typeof useFlags>
const mockMapChainInfo = mapChainInfo as jest.MockedFunction<typeof mapChainInfo>

describe('useSupportedChains', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockMapChainInfo.mockImplementation((id) => ({ id, label: `Chain ${id}` }) as unknown as ChainInfo)
    mockUseFlags.mockReturnValue({})
  })

  it('returns ChainInfo for all available chains', () => {
    const { result } = renderHook(() => useSupportedChains())

    expect(result.current.length).toBeGreaterThan(0)
    result.current.forEach((chain) => {
      // Ophis fork: 3 chains supported at FE layer even though the SDK enum
      // doesn't list them as primary SupportedChainId entries:
      //   - 10 (Optimism mainnet)
      //   - 4326 (MegaETH mainnet — paused 2026-05-18 but FE still wires)
      //   - 999 (HyperEVM mainnet — paused 2026-05-19 but FE still wires)
      const OPHIS_NON_SDK_CHAINS = new Set([10, 4326, 999])
      expect(chain.id in SupportedChainId || OPHIS_NON_SDK_CHAINS.has(chain.id)).toBe(true)
    })
  })

  it('calls mapChainInfo with correct chainId and CHAIN_INFO entry', () => {
    renderHook(() => useSupportedChains())

    expect(mockMapChainInfo).toHaveBeenCalledWith(SupportedChainId.MAINNET, CHAIN_INFO[SupportedChainId.MAINNET])
  })
})
