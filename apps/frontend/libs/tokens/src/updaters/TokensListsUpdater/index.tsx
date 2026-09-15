import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useEffect } from 'react'

import { isInjectedWidget } from '@cowprotocol/common-utils'
import { ChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'

import * as Sentry from '@sentry/browser'

import { useTokenListsQuery } from './useTokenListsQuery'

import { environmentAtom, updateEnvironmentAtom } from '../../state/environmentAtom'
import { UserAddedTokensUpdater } from '../UserAddedTokensUpdater'

const NETWORKS_WITHOUT_RESTRICTIONS: SupportedChainId[] = [SupportedChainId.SEPOLIA]

interface TokensListsUpdaterProps {
  chainId: SupportedChainId
  isGeoBlockEnabled: boolean
  enableLpTokensByDefault: boolean
  isYieldEnabled: boolean
  bridgeNetworkInfo: ChainInfo[] | undefined
}

/**
 * Geoblock query related errors to be ignored
 *
 * Those can happen when the domain we use to detect user's location is inaccessible, usually due to adblockers
 * Errors not meeting these filters will still be logged as usual
 */
const GEOBLOCK_ERRORS_TO_IGNORE = /(failed to fetch)|(load failed)/i

// TODO: Break down this large function into smaller functions
export function TokensListsUpdater({
  chainId: currentChainId,
  isGeoBlockEnabled,
  enableLpTokensByDefault,
  isYieldEnabled,
  bridgeNetworkInfo,
}: TokensListsUpdaterProps): ReactNode {
  const { chainId } = useAtomValue(environmentAtom)
  const setEnvironment = useSetAtom(updateEnvironmentAtom)
  useTokenListsQuery()

  useEffect(() => {
    setEnvironment({ chainId: currentChainId, enableLpTokensByDefault, isYieldEnabled, bridgeNetworkInfo })
  }, [setEnvironment, currentChainId, enableLpTokensByDefault, isYieldEnabled, bridgeNetworkInfo])

  // Check if a user is from US and use Uniswap list, because of the SEC regulations
  useEffect(() => {
    if (!isGeoBlockEnabled || isInjectedWidget()) return

    if (NETWORKS_WITHOUT_RESTRICTIONS.includes(chainId)) {
      setEnvironment({ useCuratedListOnly: false })
      return
    }

    fetch('https://api.country.is')
      .then((res) => res.json())
      .then(({ country }) => {
        const isUsUser = country === 'US'

        if (isUsUser) {
          setEnvironment({ useCuratedListOnly: true })
        }
      })
      .catch((error) => {
        if (GEOBLOCK_ERRORS_TO_IGNORE.test(error?.toString())) return

        const sentryError = Object.assign(error, {
          name: 'GeoBlockingError',
        })

        Sentry.captureException(sentryError, {
          tags: {
            errorType: 'GeoBlockingError',
          },
        })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, isGeoBlockEnabled])

  return <UserAddedTokensUpdater />
}
