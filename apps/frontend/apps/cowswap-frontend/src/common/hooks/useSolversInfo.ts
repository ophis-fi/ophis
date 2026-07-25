import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isBarnBackendEnv } from '@cowprotocol/common-utils'
import { SolverInfo, solversInfoAtom } from '@cowprotocol/core'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { getOphisSolversForChain, OphisStaticSolverInfo } from 'ophis/solvers'

export function useSolversInfo(chainId: SupportedChainId): Record<string, SolverInfo> {
  const allSolversInfo = useAtomValue(solversInfoAtom)

  return useMemo(() => {
    // Filters by 'staging' for non-prod (dev/local/"barn") environments because the `solversInfoAtom` data (via CMS mapping) uses 'staging' for these cases.
    const envToFilter = isBarnBackendEnv ? 'staging' : 'prod'

    const cmsSolvers = allSolversInfo.reduce<Record<string, SolverInfo>>((acc, info) => {
      if (
        info.solverNetworks.some(
          ({ env: solverEnv, chainId: solverChainId }) => solverEnv === envToFilter && solverChainId === chainId,
        )
      ) {
        acc[info.solverId.toLowerCase()] = info
      }

      return acc
    }, {})

    // Ophis: sovereign chains (self-hosted orderbook) are unknown to the CoW
    // CMS, so backfill from the static registry. The CMS wins on collision;
    // registry entries only fill the gaps.
    return getOphisSolversForChain(chainId).reduce<Record<string, SolverInfo>>((acc, staticInfo) => {
      const key = staticInfo.solverId.toLowerCase()

      if (!acc[key]) {
        acc[key] = staticSolverToSolverInfo(staticInfo)
      }

      return acc
    }, cmsSolvers)
  }, [chainId, allSolversInfo])
}

function staticSolverToSolverInfo(staticInfo: OphisStaticSolverInfo): SolverInfo {
  return {
    solverId: staticInfo.solverId,
    displayName: staticInfo.displayName,
    description: staticInfo.description,
    // Both envs: the sovereign orderbook has no barn counterpart, and local/dev
    // builds filter by 'staging', so a prod-only entry would vanish there.
    solverNetworks: staticInfo.chainIds.flatMap((solverChainId) => [
      { chainId: solverChainId as SupportedChainId, env: 'prod' as const },
      { chainId: solverChainId as SupportedChainId, env: 'staging' as const },
    ]),
  }
}
