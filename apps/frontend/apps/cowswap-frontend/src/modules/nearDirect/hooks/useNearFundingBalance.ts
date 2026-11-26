import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'
import { useWalletChainId } from '@cowprotocol/wallet-provider'

import useSWR from 'swr'
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
  const { data, error } = useSWR(
    wallet && account && chainId === currency.chainId && supported && areAddressesEqual(account, refundTo)
      ? ([
          'near-funding-balance',
          wallet.uid,
          chainId,
          account,
          source.assetId,
          source.contractAddress,
          source.decimals,
        ] as const)
      : null,
    async ([, , id, address, , contract, precision]) => {
      if (!wallet || (await wallet.getChainId()) !== id) return null
      const client = createPublicClient({ transport: custom({ request: wallet.request }, { retryCount: 0 }) })
      if (!contract) return client.getBalance({ address })
      const token = getAddress(contract)
      const [balance, decimals] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
        client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ])
      return decimals === precision ? balance : null
    },
    { keepPreviousData: false, shouldRetryOnError: false },
  )
  return data == null || error ? null : CurrencyAmount.fromRawAmount(currency, data.toString())
}
