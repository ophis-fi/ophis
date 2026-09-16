import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { COW_PROTOCOL_ETH_FLOW_ADDRESS, withTimeout } from '@cowprotocol/common-utils'
import { QuoteAndPost } from '@cowprotocol/cow-sdk'
import { CoWSwapEthFlowAbi } from '@cowprotocol/cowswap-abis'
import { Interface } from '@ethersproject/abi'

import { atomWithQuery } from 'jotai-tanstack-query'

const ethFlow = new Interface(CoWSwapEthFlowAbi)
type DepositGas = { gas: bigint; loading: boolean }

export function useCowDepositGas(quote: QuoteAndPost | null, account: string | undefined): DepositGas {
  const order = quote?.quoteResults.orderToSign
  const quoteId = quote?.quoteResults.quoteResponse.id
  const orderKey = JSON.stringify(order)
  const query = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['cowDepositGas', account, orderKey, quoteId],
        enabled: !!account && !!order,
        queryFn: async () => {
          if (!account || !order) return 0n
          return BigInt(
            await withTimeout(
              getRpcProvider(1).send('eth_estimateGas', [
                {
                  from: account,
                  to: COW_PROTOCOL_ETH_FLOW_ADDRESS[1],
                  data: ethFlow.encodeFunctionData('createOrder', [{ ...order, quoteId }]),
                  value: `0x${BigInt(order.sellAmount).toString(16)}`,
                },
                'latest',
                { [account]: { balance: '0x3635c9adc5dea00000' } },
              ]),
              10000,
            ),
          )
        },
        retry: false,
        staleTime: 15000,
      })),
    [account, orderKey, quoteId, order],
  )
  // On simulation failure retain the signed input as a conservative lower bound.
  const result = useAtomValue(query)
  return { gas: result.data || 0n, loading: !!account && !!order && result.isPending }
}
