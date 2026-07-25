import { useAtomValue } from 'jotai'

import { SolverInfo } from '@cowprotocol/core'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { renderHook } from '@testing-library/react'

import { OPHIS_SOLVER_REGISTRY_CHAIN_ID, OPHIS_SOLVERS } from 'ophis/solvers'

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

    expect(Object.keys(result.current).length).toBe(OPHIS_SOLVERS.length)
    expect(result.current['baseline'].displayName).toBe('Baseline')
    expect(result.current['kyberswap'].solverNetworks).toEqual(
      expect.arrayContaining([{ chainId: OPTIMISM, env: 'prod' }]),
    )
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
    expect(Object.keys(result.current).length).toBe(OPHIS_SOLVERS.length)
  })

  it('does not add registry entries on CoW-hosted chains', () => {
    const { result } = renderHook(() => useSolversInfo(SupportedChainId.MAINNET))

    expect(Object.keys(result.current).length).toBe(0)
  })
})
