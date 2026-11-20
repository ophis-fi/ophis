import { NATIVE_CURRENCY_ADDRESS, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { OrderKind, setGlobalAdapter, SupportedChainId, ZERO_ADDRESS } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { JsonRpcProvider } from '@ethersproject/providers'

import { OphisAcrossV5Provider } from './ophisAcrossV5Provider'
import { OphisAcrossBridgeProvider } from './ophisBridgeProviders'

jest.mock('@cowprotocol/tokens', () => ({
  OPHIS_TOKENS_LIST_SOURCE: {},
  fetchTokenList: async () => ({ list: { tokens: [] } }),
}))

const WETH = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.BASE]

it('trusts wrapped ETH as the bridge input and requests native ETH on the destination', async () => {
  setGlobalAdapter(new EthersV5Adapter({ provider: new JsonRpcProvider() }))
  const request: QuoteBridgeRequest = {
    kind: OrderKind.SELL,
    account: '0x1111111111111111111111111111111111111111',
    amount: 10n ** 18n,
    sellTokenChainId: SupportedChainId.BASE,
    sellTokenAddress: WETH.address,
    sellTokenDecimals: 18,
    buyTokenChainId: SupportedChainId.MAINNET,
    buyTokenAddress: NATIVE_CURRENCY_ADDRESS,
    buyTokenDecimals: 18,
  }
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        originTokens: [
          { chainId: WETH.chainId, address: WETH.address, symbol: WETH.symbol, name: 'Wrapped Ether', decimals: 18 },
        ],
      }),
    } as Response)
    .mockRejectedValueOnce(new Error('quote request reached'))
  try {
    const provider = new OphisAcrossV5Provider(new OphisAcrossBridgeProvider(), async () => [])
    const intermediates = await provider.getIntermediateTokens(request)
    expect(intermediates.map((token) => token.address)).toEqual([WETH.address])
    expect(String(fetchSpy.mock.calls[0][0])).toContain('destinationToken=' + ZERO_ADDRESS)
    await expect(provider.getQuote(request)).rejects.toThrow('quote request reached')
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toMatchObject({
      inputToken: WETH.address,
      outputToken: ZERO_ADDRESS,
    })
  } finally {
    fetchSpy.mockRestore()
  }
})
