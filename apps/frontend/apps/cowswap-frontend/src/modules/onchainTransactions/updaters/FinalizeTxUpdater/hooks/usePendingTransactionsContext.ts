import { useGnosisSafeInfo, useWalletInfo } from '@cowprotocol/wallet'
import { useWalletProvider } from '@cowprotocol/wallet-provider'

import { useAsyncMemo } from 'use-async-memo'

import { useGetSafeTxInfo } from 'legacy/hooks/useGetSafeTxInfo'
import { useAppDispatch } from 'legacy/state/hooks'
import { useCancelOrdersBatch } from 'legacy/state/orders/hooks'

import { useGetTwapOrderById } from 'modules/twap/hooks/useGetTwapOrderById'

import { useBlockNumber } from 'common/hooks/useBlockNumber'
import { useGetReceipt } from 'common/hooks/useGetReceipt'
import useNativeCurrency from 'lib/hooks/useNativeCurrency'

import { CheckEthereumTransactions } from '../types'

export function usePendingTransactionsContext(): CheckEthereumTransactions | null {
  // TODO M-6 COW-573
  // This flow will be reviewed and updated later, to include a wagmi alternative
  const provider = useWalletProvider()
  const { chainId, account } = useWalletInfo()
  const safeInfo = useGnosisSafeInfo()
  const isSafeWallet = !!safeInfo
  const lastBlockNumber = useBlockNumber()

  const dispatch = useAppDispatch()
  const cancelOrdersBatch = useCancelOrdersBatch()
  const getReceipt = useGetReceipt(chainId)
  const getTxSafeInfo = useGetSafeTxInfo()
  const getTwapOrderById = useGetTwapOrderById()
  // Defensive: useNativeCurrency() returns undefined when the connected
  // wallet's chainId is outside our TargetChainId set (e.g. MetaMask on
  // Polygon, BSC, Avalanche, etc.). This updater mounts on EVERY page so
  // an unguarded dereference crashes the entire app at load — the 2026-05-17
  // root-cause site for the persistent "Cannot read properties of undefined
  // (reading 'symbol')" crash. The label is decorative ("Approve in your
  // wallet" tooltips); 'ETH' is a safe default for any unsupported chain.
  const nativeCurrencySymbol = useNativeCurrency()?.symbol || 'ETH'

  return useAsyncMemo(
    async () => {
      if (!provider || !lastBlockNumber || !account) return null

      const transactionsCount = await provider.getTransactionCount(account)

      const params: CheckEthereumTransactions = {
        chainId,
        isSafeWallet,
        lastBlockNumber,
        getReceipt,
        getTxSafeInfo,
        dispatch,
        nativeCurrencySymbol,
        cancelOrdersBatch,
        account,
        getTwapOrderById,
        transactionsCount,
        safeInfo,
      }

      return params
    },
    [
      chainId,
      account,
      isSafeWallet,
      provider,
      lastBlockNumber,
      dispatch,
      getReceipt,
      getTxSafeInfo,
      nativeCurrencySymbol,
      cancelOrdersBatch,
      getTwapOrderById,
      safeInfo,
    ],
    null,
  )
}
