import { useSetAtom } from 'jotai'
import { useEffect, useMemo, useState } from 'react'

import { LAUNCH_DARKLY_VIEM_MIGRATION } from '@cowprotocol/common-const'
import { getCurrentChainIdFromUrl } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { useSafeAppsSDK } from '@safe-global/safe-apps-react-sdk'

import { Address } from 'viem'
import { useConnection, useEnsName } from 'wagmi'

import { useIsSmartContractWallet } from './hooks/useIsSmartContractWallet'
import { useIsSafeApp, useWalletMetaData } from './hooks/useWalletMetadata'

import { gnosisSafeInfoAtom, walletDetailsAtom, walletInfoAtom } from '../api/state'
import { GnosisSafeInfo, WalletDetails, WalletInfo } from '../api/types'
import { getWalletType } from '../api/utils/getWalletType'
import { getWalletTypeLabel } from '../api/utils/getWalletTypeLabel'

function useWalletInfo(): WalletInfo {
  const { address, chainId, isConnected } = useConnection()
  // Ophis fork: chains 10 (OP Mainnet), 4326 (MegaETH Mainnet), and 999
  // (HyperEVM Mainnet) are supported at the frontend layer even though the SDK
  // enum doesn't include them. Without this, switching the wallet to any of
  // these chains is treated as "unsupported" and silently falls back to MAINNET.
  const isChainIdUnsupported =
    !!chainId && !(chainId in SupportedChainId) && chainId !== 10 && chainId !== 4326 && chainId !== 999

  return useMemo(
    () => ({
      chainId: isChainIdUnsupported || !chainId ? getCurrentChainIdFromUrl() : chainId,
      active: isConnected,
      account: address,
    }),
    [address, chainId, isConnected, isChainIdUnsupported],
  )
}

// Smart contract wallets are filtered out by default, no need to add them to this list
const UNSUPPORTED_WC_WALLETS = new Set(['DeFi Wallet', 'WallETH'])

function checkIsSupportedWallet(walletName?: string): boolean {
  return !(walletName && UNSUPPORTED_WC_WALLETS.has(walletName))
}

function useWalletDetails(account?: Address, standaloneMode?: boolean): WalletDetails {
  const { data: ensName } = useEnsName({ address: account })
  const isSmartContractWallet = useIsSmartContractWallet()
  const { walletName, icon } = useWalletMetaData(standaloneMode)
  const isSafeApp = useIsSafeApp()

  return useMemo(() => {
    return {
      isSmartContractWallet,
      walletName,
      icon,
      ensName: ensName || undefined,
      isSupportedWallet: checkIsSupportedWallet(walletName),

      // TODO: For now, all SC wallets use pre-sign instead of offchain signing
      // In the future, once the API adds EIP-1271 support, we can allow some SC wallets to use offchain signing
      allowsOffchainSigning: !isSmartContractWallet,
      isSafeApp,
    }
  }, [isSmartContractWallet, isSafeApp, walletName, icon, ensName])
}

function useSafeInfo(_walletInfo: WalletInfo): GnosisSafeInfo | undefined {
  const { connected, safe, sdk } = useSafeAppsSDK()

  const [safeInfo, setSafeInfo] = useState<GnosisSafeInfo>()

  useEffect(() => {
    if (connected) {
      // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
      const getInfo = async () => {
        const fetchedInfo = await sdk.safe.getInfo()
        setSafeInfo({ ...fetchedInfo, address: fetchedInfo.safeAddress })
      }
      getInfo()
    } else {
      // TODO M-3 COW-569
      // Wagmi connection to safe will be refined in a future task
    }
  }, [connected, sdk, safe])

  return safeInfo
}

interface WalletUpdaterProps {
  standaloneMode?: boolean
}

export function WalletUpdater({ standaloneMode }: WalletUpdaterProps): null {
  const walletInfo = useWalletInfo()
  const walletDetails = useWalletDetails(walletInfo.account, standaloneMode)
  const gnosisSafeInfo = useSafeInfo(walletInfo)

  const setWalletInfo = useSetAtom(walletInfoAtom)
  const setWalletDetails = useSetAtom(walletDetailsAtom)
  const setGnosisSafeInfo = useSetAtom(gnosisSafeInfoAtom)

  // Update wallet info
  useEffect(() => {
    if (!LAUNCH_DARKLY_VIEM_MIGRATION) {
      return
    }
    setWalletInfo(walletInfo)
  }, [walletInfo, setWalletInfo])

  // Update wallet details
  useEffect(() => {
    if (!LAUNCH_DARKLY_VIEM_MIGRATION) {
      return
    }
    const walletType = getWalletType({ gnosisSafeInfo, isSmartContractWallet: walletDetails.isSmartContractWallet })
    setWalletDetails({
      ...walletDetails,
      walletName: getWalletTypeLabel(walletType) || walletDetails.walletName,
    })
  }, [walletDetails, setWalletDetails, gnosisSafeInfo])

  // Update Gnosis Safe info
  useEffect(() => {
    if (!LAUNCH_DARKLY_VIEM_MIGRATION) {
      return
    }
    setGnosisSafeInfo(gnosisSafeInfo)
  }, [gnosisSafeInfo, setGnosisSafeInfo])

  return null
}
