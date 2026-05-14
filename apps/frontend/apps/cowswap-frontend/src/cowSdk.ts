import { useEffect } from 'react'

import { getRpcProvider, LAUNCH_DARKLY_VIEM_MIGRATION } from '@cowprotocol/common-const'
import { getCurrentChainIdFromUrl, isBarnBackendEnv } from '@cowprotocol/common-utils'
import {
  ApiBaseUrls,
  DEFAULT_BACKOFF_OPTIONS,
  MetadataApi,
  OrderBookApi,
  setGlobalAdapter,
  SupportedChainId,
  AbstractProviderAdapter,
} from '@cowprotocol/cow-sdk'
import { PERMIT_ACCOUNT } from '@cowprotocol/permit-utils'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { ViemAdapter } from '@cowprotocol/sdk-viem-adapter'
import { useWeb3React } from '@web3-react/core'

import { usePublicClient, useWalletClient } from 'wagmi'

const chainId = getCurrentChainIdFromUrl()

// Ophis fork: hardcode the full OrderBook baseUrls map including OP mainnet (chain 10).
// We always pass an explicit map so that the SDK uses our Ophis OP orderbook URL.
// Override via REACT_APP_ORDER_BOOK_URLS env if needed (merged on top of this base).
const PROD_BASE_URL = 'https://api.cow.fi'
const OPHIS_OP_ORDERBOOK_URL = 'https://optimism-mainnet.ophis.fi'

const OPHIS_ORDERBOOK_BASE_URLS = {
  [SupportedChainId.MAINNET]: `${PROD_BASE_URL}/mainnet`,
  [SupportedChainId.GNOSIS_CHAIN]: `${PROD_BASE_URL}/xdai`,
  [SupportedChainId.ARBITRUM_ONE]: `${PROD_BASE_URL}/arbitrum_one`,
  [SupportedChainId.BASE]: `${PROD_BASE_URL}/base`,
  [SupportedChainId.SEPOLIA]: `${PROD_BASE_URL}/sepolia`,
  [SupportedChainId.POLYGON]: `${PROD_BASE_URL}/polygon`,
  [SupportedChainId.AVALANCHE]: `${PROD_BASE_URL}/avalanche`,
  [SupportedChainId.BNB]: `${PROD_BASE_URL}/bnb`,
  [SupportedChainId.LINEA]: `${PROD_BASE_URL}/linea`,
  [SupportedChainId.PLASMA]: `${PROD_BASE_URL}/plasma`,
  [SupportedChainId.INK]: `${PROD_BASE_URL}/ink`,
  // Ophis OP mainnet orderbook (verified live)
  [10 as unknown as SupportedChainId]: OPHIS_OP_ORDERBOOK_URL,
} as unknown as ApiBaseUrls

const envBaseUrls = process.env.REACT_APP_ORDER_BOOK_URLS
  ? JSON.parse(process.env.REACT_APP_ORDER_BOOK_URLS)
  : undefined

const baseUrls = (envBaseUrls
  ? { ...OPHIS_ORDERBOOK_BASE_URLS, ...envBaseUrls }
  : OPHIS_ORDERBOOK_BASE_URLS) as unknown as ApiBaseUrls

const legacyAdapter = new EthersV5Adapter({
  provider: getRpcProvider(chainId)!,
})

setGlobalAdapter(legacyAdapter)

export const orderBookApi = new OrderBookApi({
  env: isBarnBackendEnv ? 'staging' : 'prod',
  baseUrls,
  backoffOpts: DEFAULT_BACKOFF_OPTIONS,
})

export const metadataApiSDK = new MetadataApi()

export function CowSdkUpdater(): null {
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const { chainId, provider, account } = useWeb3React()

  useEffect(() => {
    if (!LAUNCH_DARKLY_VIEM_MIGRATION) return
    if (!publicClient) return
    if (walletClient) {
      // TODO: fix the type casting
      setGlobalAdapter(new ViemAdapter({ provider: publicClient, walletClient }) as AbstractProviderAdapter)
    } else {
      setGlobalAdapter(new ViemAdapter({ provider: publicClient, signer: PERMIT_ACCOUNT }) as AbstractProviderAdapter)
    }
  }, [publicClient, walletClient])

  useEffect(() => {
    if (LAUNCH_DARKLY_VIEM_MIGRATION) return
    if (!provider) return
    legacyAdapter.setProvider(provider)
    legacyAdapter.setSigner(provider.getSigner())
  }, [chainId, account, provider])

  return null
}
