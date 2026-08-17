import { LAUNCH_DARKLY_VIEM_MIGRATION, SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import { isInjectedWidget, isMobile, log } from '@cowprotocol/common-utils'
import type { SupportedChainId } from '@cowprotocol/cow-sdk'
import { useWalletProvider } from '@cowprotocol/wallet-provider'
import type { Web3Provider } from '@ethersproject/providers'

import ms from 'ms.macro'
import useSWR from 'swr'
import { useCapabilities } from 'wagmi'

import { useWidgetProviderMetaInfo } from './useWidgetProviderMetaInfo'

import { useIsWalletConnect } from '../../wagmi/hooks/useIsWalletConnect'
import { useIsWalletConnect as legacyUseIsWalletConnect } from '../../web3-react/hooks/useIsWalletConnect'
import { useWalletInfo } from '../hooks'
import {
  getWalletCapabilitiesForChain,
  parseWalletCapabilities,
  type WalletCapabilities,
} from '../pure/walletCapabilities'

const requestTimeout = ms`10s`

const EMPTY_SWR_RESPONSE = { data: undefined, isLoading: true }

type CapabilitiesResponse = { data: WalletCapabilities | undefined; isLoading: boolean }
type CapabilitiesSWRKey = readonly [Web3Provider, string, SupportedChainId] | null

/**
 * Walletconnect in mobile browsers initiates a request with confirmation to the wallet
 * to get the capabilities. It breaks the flow with perpetual requests.
 */
function shouldCheckCapabilities(
  isWalletConnect: boolean,
  { data, isLoading }: ReturnType<typeof useWidgetProviderMetaInfo>,
): boolean {
  // When widget in the mobile device, wait till providerWcMetadata is loaded
  // In order to detect if is connected to WalletConnect
  if (isInjectedWidget() && isMobile && isLoading) {
    return false
  }

  const isWalletConnectViaWidget = Boolean(data?.providerWcMetadata)

  return !((isWalletConnect || isWalletConnectViaWidget) && isMobile)
}

function canFetchCapabilities(
  shouldCheck: boolean,
  provider: Web3Provider | undefined,
  account: string | undefined,
  chainId: SupportedChainId | undefined,
): boolean {
  return Boolean(shouldCheck && provider && account && chainId)
}

function getCapabilitiesSWRKey(
  shouldFetch: boolean,
  provider: Web3Provider | undefined,
  account: string | undefined,
  chainId: SupportedChainId | undefined,
): CapabilitiesSWRKey {
  return shouldFetch && provider && account && chainId ? [provider, account, chainId] : null
}

function selectCapabilitiesResponse(
  wagmiResponse: { data: unknown; isLoading: boolean },
  swrResponse: CapabilitiesResponse,
  shouldFetch: boolean,
  isWidgetMetadataLoading: boolean,
): CapabilitiesResponse {
  if (LAUNCH_DARKLY_VIEM_MIGRATION) {
    return { data: parseWalletCapabilities(wagmiResponse.data), isLoading: wagmiResponse.isLoading }
  }

  return !shouldFetch && isWidgetMetadataLoading ? EMPTY_SWR_RESPONSE : swrResponse
}

export function useWalletCapabilities(): { data: WalletCapabilities | undefined; isLoading: boolean } {
  const provider = useWalletProvider()
  const newIsWalletConnect = useIsWalletConnect()
  const legacyIsWalletConnect = legacyUseIsWalletConnect()
  const widgetProviderMetaInfo = useWidgetProviderMetaInfo()
  const { chainId, account } = useWalletInfo()

  const capabilities = useCapabilities({ account, chainId })

  const isWalletConnect = LAUNCH_DARKLY_VIEM_MIGRATION ? newIsWalletConnect : legacyIsWalletConnect
  const shouldFetchCapabilities = canFetchCapabilities(
    shouldCheckCapabilities(isWalletConnect, widgetProviderMetaInfo),
    provider,
    account,
    chainId,
  )
  const swrKey = getCapabilitiesSWRKey(shouldFetchCapabilities, provider, account, chainId)

  const swrResponse = useSWR<WalletCapabilities | undefined, unknown, CapabilitiesSWRKey>(
    swrKey,
    ([provider, account, chainId]) => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve(undefined)
        }, requestTimeout)

        provider
          .send('wallet_getCapabilities', [account])
          .then((result: unknown) => {
            clearTimeout(timeout)
            resolve(getWalletCapabilitiesForChain(result, chainId))
          })
          .catch((error: unknown) => {
            // Ophis fork: many wallets / RPCs (notably some OP-mainnet providers)
            // do not implement `wallet_getCapabilities` and reject with -32601
            // (Method not found) or -32603 (Internal error). Treat the call as
            // unsupported instead of spamming the console.
            const code = getProviderErrorCode(error)
            if (code === -32601 || code === -32603 || code === -32004) {
              log('WalletCapabilities', '#6b7280', 'Provider does not support capability discovery', code)
            } else {
              log('WalletCapabilities', '#b45309', 'Capability discovery failed', error)
            }
            clearTimeout(timeout)
            resolve(undefined)
          })
      })
    },
    SWR_NO_REFRESH_OPTIONS,
  )

  return selectCapabilitiesResponse(
    capabilities,
    swrResponse,
    shouldFetchCapabilities,
    widgetProviderMetaInfo.isLoading,
  )
}

function getProviderErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  const directCode = Reflect.get(error, 'code')
  if (typeof directCode === 'number') return directCode

  const cause = Reflect.get(error, 'cause')
  if (typeof cause !== 'object' || cause === null) return undefined

  const causeCode = Reflect.get(cause, 'code')

  return typeof causeCode === 'number' ? causeCode : undefined
}
