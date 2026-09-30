import { ARC_CHAIN_ID, ARC_READ_RPC_URL, ARC_RPC_URL, RPC_URLS } from '@cowprotocol/common-const'
import { StaticJsonRpcProvider } from '@ethersproject/providers'

export class ArcReadProvider extends StaticJsonRpcProvider {
  private readonly fallback: StaticJsonRpcProvider

  constructor() {
    const configuredUrl = RPC_URLS[ARC_CHAIN_ID]
    const primaryUrl = configuredUrl === ARC_RPC_URL ? ARC_READ_RPC_URL : configuredUrl
    super({ url: primaryUrl, timeout: 4000, throttleLimit: 1 }, ARC_CHAIN_ID)
    this.fallback = new StaticJsonRpcProvider(
      { url: primaryUrl === ARC_READ_RPC_URL ? ARC_RPC_URL : ARC_READ_RPC_URL, timeout: 4000, throttleLimit: 1 },
      ARC_CHAIN_ID,
    )
  }

  override async send(method: string, params: unknown[]): Promise<unknown> {
    try {
      return await super.send(method, params)
    } catch (error) {
      // Retry before ethers v5 turns transport failures into CALL_EXCEPTION.
      // Only reads may use the fallback; signing stays with the wallet.
      if (!['eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_getCode'].includes(method)) throw error
      return this.fallback.send(method, params)
    }
  }
}
