import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useWalletChainId } from '@cowprotocol/wallet-provider'

import { atomWithQuery } from 'jotai-tanstack-query'
import { createPublicClient, erc20Abi, getAddress, http } from 'viem'

import { useBridgeWallet } from 'modules/cctp'

import { NearToken } from '../nearDirect.schemas'
import { nearEvmFundingChain } from '../nearDirectWallet.service'

/** Direct deposit amounts belong to the sending wallet only when it matches the refund account and source chain. */
export function useNearFundingBalance(
  source: NearToken | undefined,
  currency: Currency,
  refundTo: string,
): CurrencyAmount<Currency> | null {
  const wallet = useBridgeWallet()
  const { account } = useWalletInfo()
  const chainId = useWalletChainId()
  const chain = nearEvmFundingChain(source?.blockchain)
  const fundingAccount =
    account && chainId === currency.chainId && chain?.id === chainId && areAddressesEqual(account, refundTo)
      ? account
      : undefined
  const { assetId, contractAddress, decimals } = source ?? {}
  const balanceAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['nearFundingBalance', wallet?.uid, chainId, fundingAccount, assetId, contractAddress, decimals],
        enabled: !!wallet && !!fundingAccount,
        retry: false,
        queryFn: async ({ signal }) => {
          if (!wallet || !fundingAccount || !chain || (await wallet.getChainId()) !== chain.id) return null
          signal.throwIfAborted()
          // A wallet transport can switch networks between balanceOf and decimals.
          const client = createPublicClient({
            chain,
            transport: http(undefined, { retryCount: 0, fetchOptions: { signal } }),
          })
          if (!contractAddress) return client.getBalance({ address: fundingAccount })
          const token = getAddress(contractAddress)
          const [balance, precision] = await Promise.all([
            client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [fundingAccount] }),
            client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
          ])
          return decimals === precision ? balance : null
        },
      })),
    [wallet, chain, chainId, fundingAccount, assetId, contractAddress, decimals],
  )
  const { data, isError } = useAtomValue(balanceAtom)
  return data == null || isError ? null : CurrencyAmount.fromRawAmount(currency, data.toString())
}
