import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useWalletChainId } from '@cowprotocol/wallet-provider'

import { atomWithQuery } from 'jotai-tanstack-query'
import { createPublicClient, custom, erc20Abi, getAddress } from 'viem'

import { useBridgeWallet } from 'modules/cctp'

import { NearToken } from '../nearDirect.schemas'

/** Direct deposit amounts belong to the sending wallet only when it matches the refund account and source chain. */
export function useNearFundingBalance(
  source: NearToken | undefined,
  currency: Currency,
  refundTo: string,
): CurrencyAmount<Currency> | null {
  const wallet = useBridgeWallet()
  const { account } = useWalletInfo()
  const chainId = useWalletChainId()
  const supported = source && ['monad', 'xlayer'].includes(source.blockchain)
  const fundingAccount =
    wallet && account && chainId === currency.chainId && supported && areAddressesEqual(account, refundTo)
      ? account
      : undefined
  const { assetId, contractAddress, decimals } = source ?? {}
  const balanceAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['nearFundingBalance', wallet?.uid, chainId, fundingAccount, assetId, contractAddress, decimals],
        enabled: !!fundingAccount,
        retry: false,
        queryFn: async ({ signal }) => {
          if (!wallet || !fundingAccount || (await wallet.getChainId()) !== chainId) return null
          signal.throwIfAborted()
          const client = createPublicClient({ transport: custom({ request: wallet.request }, { retryCount: 0 }) })
          if (!contractAddress) return client.getBalance({ address: fundingAccount })
          const token = getAddress(contractAddress)
          const [balance, precision] = await Promise.all([
            client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [fundingAccount] }),
            client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
          ])
          return decimals === precision ? balance : null
        },
      })),
    [wallet, chainId, fundingAccount, assetId, contractAddress, decimals],
  )
  const { data, isError } = useAtomValue(balanceAtom)
  return data == null || isError ? null : CurrencyAmount.fromRawAmount(currency, data.toString())
}
