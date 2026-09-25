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
    expect(result.current['baseline'].displayName).toBe('Ophis Baseline')
    expect(result.current['kyberswap'].solverNetworks).toEqual(
      expect.arrayContaining([{ chainId: OPTIMISM, env: 'prod' }]),
    )
  })

  it('shows provider names and the Ophis operator logo for its routing lanes', () => {
    const { result } = renderHook(() => useSolversInfo(OPTIMISM))

    expect(result.current['kyberswap'].displayName).toBe('KyberSwap')
    expect(result.current['velora'].displayName).toBe('Velora')
    expect(result.current['lifi'].displayName).toBe('LI.FI')
    expect(result.current['kyberswap'].description).toContain('Ophis-operated')
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

  it('counts only the configured Arc lanes and resolves their names without CMS data', () => {
    const { result } = renderHook(() => useSolversInfo(5042 as SupportedChainId))

    expect(Object.keys(result.current)).toEqual(['kyberswap', 'uniswap-v3'])
    expect(result.current['kyberswap'].displayName).toBe('KyberSwap')
    expect(result.current['uniswap-v3']).toMatchObject({
      displayName: 'Uniswap v3',
      description: 'Ophis-operated routing lane: Uniswap v3.',
      solverNetworks: expect.arrayContaining([{ chainId: 5042, env: 'prod' }]),
    })
  })
})
