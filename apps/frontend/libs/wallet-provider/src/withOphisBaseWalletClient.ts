import { createPublicClient, createWalletClient, custom, type PublicClient, type WalletClient } from 'viem'

import { assertAttributedTransactionGas, withOphisBaseTransactionParams } from './baseBuilderCode'
import { withAppRpcFallback } from './WalletFirstReadProvider'

export function withOphisBasePublicClient(client: PublicClient): PublicClient {
  if (client.chain?.id !== 8453) return client
  return createPublicClient({
    ...client,
    transport: custom({
      request: ({ method, params }: { method: string; params?: unknown }) =>
        client.transport.request({
          method,
          params: Array.isArray(params) ? withOphisBaseTransactionParams(method, params, 8453) : params,
        }),
    }),
  })
}

export function withOphisBaseWalletClient(client: WalletClient): WalletClient {
  if (client.chain?.id !== 8453) return client
  const reads = withAppRpcFallback(8453, {
    send: (method: string, params: unknown[]) => client.transport.request({ method, params }),
  })
  return createWalletClient({
    account: client.account,
    chain: client.chain,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
          if (
            ['eth_estimateGas', 'eth_sendTransaction', 'wallet_sendTransaction', 'wallet_sendCalls'].includes(method)
          ) {
            if ((await client.getChainId()) !== 8453) throw new Error('Wallet network changed. Please retry.')
            if (Array.isArray(params)) {
              const attributed = withOphisBaseTransactionParams(method, params, 8453)
              if (['eth_sendTransaction', 'wallet_sendTransaction'].includes(method) && attributed !== params) {
                await assertAttributedTransactionGas(attributed, (method, params) => reads.send(method, params))
                if ((await client.getChainId()) !== 8453) throw new Error('Wallet network changed. Please retry.')
              }
              params = attributed
            }
          }
          return client.transport.request({ method, params })
        },
      },
      { retryCount: 0 },
    ),
  })
}
