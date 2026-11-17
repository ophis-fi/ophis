import { Web3Provider } from '@ethersproject/providers'

import { assertAttributedTransactionGas, withOphisBaseTransactionParams } from './baseBuilderCode'

export class OphisBaseProvider extends Web3Provider {
  constructor(provider: Web3Provider) {
    // Keep the raw EIP-1193 provider available to third-party hook iframes.
    super(provider.provider, 8453)
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (['eth_estimateGas', 'eth_sendTransaction', 'wallet_sendTransaction', 'wallet_sendCalls'].includes(method)) {
      if (Number(await super.send('eth_chainId', [])) !== 8453) {
        throw new Error('Wallet network changed. Please retry.')
      }
      const attributed = withOphisBaseTransactionParams(method, params, 8453)
      if (['eth_sendTransaction', 'wallet_sendTransaction'].includes(method) && attributed !== params) {
        await assertAttributedTransactionGas(attributed, (method, params) => super.send(method, params))
        if (Number(await super.send('eth_chainId', [])) !== 8453)
          throw new Error('Wallet network changed. Please retry.')
      }
      params = attributed
    }
    return super.send(method, params)
  }
}
