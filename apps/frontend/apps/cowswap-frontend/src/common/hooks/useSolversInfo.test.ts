import { useAtomValue } from 'jotai'

import { SolverInfo } from '@cowprotocol/core'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'
import { getOphisSolversForChain, OPHIS_SOLVER_REGISTRY_CHAIN_ID } from 'ophis/solvers'

import { useSolversInfo } from './useSolversInfo'

jest.mock('jotai', () => ({
  ...jest.requireActual('jotai'),
  useAtomValue: jest.fn(),
}))

jest.mock('@cowprotocol/common-utils', () => ({
  ...jest.requireActual('@cowprotocol/common-utils'),
  isBarnBackendEnv: false,
}))

const useAtomValueMock = useAtomValue as jest.MockedFunction<typeof useAtomValue>

const OPTIMISM = OPHIS_SOLVER_REGISTRY_CHAIN_ID as SupportedChainId

describe('useSolversInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useAtomValueMock.mockReturnValue([])
  })

  it('falls back to the full static registry on the sovereign chain when the CMS is empty', () => {
    const { result } = renderHook(() => useSolversInfo(OPTIMISM))

    // Count the entries registered FOR THIS CHAIN, not the whole registry.
    // OPHIS_SOLVERS spans every sovereign chain, so comparing against its
    // total silently broke when the 4663-only uniswap-v4 entry was added.
    expect(Object.keys(result.current).length).toBe(getOphisSolversForChain(OPTIMISM).length)
    expect(result.current['baseline'].displayName).toBe('Baseline')
    expect(result.current['kyberswap'].solverNetworks).toEqual(
      expect.arrayContaining([{ chainId: OPTIMISM, env: 'prod' }]),
    )
  })

  it('renders external solver brands through the neutral alias (never the raw brand)', () => {
    const { result } = renderHook(() => useSolversInfo(OPTIMISM))

    // The internal id is retained for attribution, but no rendered string names the brand.
    expect(result.current['kyberswap'].solverId).toBe('kyberswap')
    expect(result.current['kyberswap'].displayName).toBe('External solver')
    expect(result.current['velora'].displayName).toBe('External solver')
    expect(result.current['velora'].displayName?.toLowerCase()).not.toContain('velora')
    expect(result.current['velora'].description?.toLowerCase()).not.toContain('velora')

    // Assert the rule, not one example: no registry entry may leak its brand
    // into rendered copy. Pinning this to a specific solver id is what made the
    // test break when the retired Odos entry was removed.
    for (const { solverId } of OPHIS_SOLVERS) {
      const rendered = result.current[solverId]
      if (!rendered || solverId === 'baseline' || solverId === 'uniswap-v4') continue
      expect(rendered.displayName).toBe('External solver')
      expect(rendered.displayName?.toLowerCase()).not.toContain(solverId.toLowerCase())
      expect(rendered.description?.toLowerCase()).not.toContain(solverId.toLowerCase())
    }
  })

  it('lets a CMS entry win over the registry on solver-id collision', () => {
    const cmsEntry: SolverInfo = {
      solverId: 'baseline',
      displayName: 'CMS Baseline',
      description: 'from the CMS',
      solverNetworks: [{ chainId: OPTIMISM, env: 'prod' }],
    }
    useAtomValueMock.mockReturnValue([cmsEntry])

    const { result } = renderHook(() => useSolversInfo(OPTIMISM))

    expect(result.current['baseline'].displayName).toBe('CMS Baseline')
    // The registry still fills the other slots.
    // Count the entries registered FOR THIS CHAIN, not the whole registry.
    // OPHIS_SOLVERS spans every sovereign chain, so comparing against its
    // total silently broke when the 4663-only uniswap-v4 entry was added.
    expect(Object.keys(result.current).length).toBe(getOphisSolversForChain(OPTIMISM).length)
  })

  it('does not add registry entries on CoW-hosted chains', () => {
    const { result } = renderHook(() => useSolversInfo(SupportedChainId.MAINNET))

    expect(Object.keys(result.current).length).toBe(0)
  })
})
