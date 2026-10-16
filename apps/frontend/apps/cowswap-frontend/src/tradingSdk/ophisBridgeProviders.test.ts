import {
  ACROSS_INK_LINEA_SOURCE_ENABLED,
  ACROSS_POLYGON_SOURCE_ENABLED,
  ACROSS_OPTIMISM_SOURCE_ENABLED,
  acrossPolygonOptimismSourceIds,
  ACROSS_ROBINHOOD_SOURCE_ENABLED,
  acrossInkLineaSourceIds,
  acrossRobinhoodSourceIds,
  BRIDGE_SOURCE_CHAIN_IDS,
  createDecodeOnlyBungeeBridgeProvider,
  DecodeOnlyBungeeBridgeProvider,
  EXTRA_ACROSS_SOURCE_CHAIN_IDS,
  getRpcProvider,
  ophisAcrossApiOptions,
  tagAcrossIntegratorCalldata,
  WRAPPED_NATIVE_CURRENCIES,
} from '@cowprotocol/common-const'
import {
  AbstractProviderAdapter,
  EvmCall,
  isEvmChainInfo,
  OrderKind,
  OrderStatus,
  setGlobalAdapter,
  SignerLike,
  SigningScheme,
  SupportedChainId,
  TargetChainId,
  TokenInfo,
} from '@cowprotocol/cow-sdk'
import { Erc20__factory } from '@cowprotocol/cowswap-abis'
import {
  AcrossBridgeProvider,
  AcrossQuoteResult,
  BridgeHook,
  BridgeQuoteErrors,
  BridgeQuoteResults,
  BungeeBridgeProvider,
  NearIntentsBridgeProvider,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'
import { CowShedHooks, CowShedSdk } from '@cowprotocol/sdk-cow-shed'
import { OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'
import { Interface } from '@ethersproject/abi'
import { BigNumber } from '@ethersproject/bignumber'
import { Wallet } from '@ethersproject/wallet'

import { readFileSync } from 'fs'
import { join } from 'path'

import { BRIDGE_QUOTE_ACCOUNT } from 'modules/tradeQuote/utils/getBridgeQuoteSigner'

import { getSwapErrorMessage } from 'common/utils/getSwapErrorMessage'

import { ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'
import {
  ACROSS_EXECUTABLE_SOURCE_IDS,
  acrossValidToLimit,
  OphisAcrossBridgeProvider,
  placeConfirmed,
} from './ophisBridgeProviders'

const ids = (chains: { id: number }[]): number[] => chains.map((c) => c.id)

// 4663 is not a SupportedChainId member (custom bridge chain, see ophisBridgeChains.ts),
// so the SDK's TargetChainId-typed params need the same cast the app relies on at runtime.
const ROBINHOOD_CHAIN_ID = 4663 as unknown as TargetChainId

// A fetch that never settles except through its abort signal (a stalled request).
const settleOnlyOnAbort = (signal?: AbortSignal | null): Promise<Response> =>
  new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))

// Typed fixtures so the tests track the SDK contract the override depends on.
const USDG_4663 = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const acrossRequest = (overrides: Partial<QuoteBridgeRequest> = {}): QuoteBridgeRequest =>
  ({
    kind: OrderKind.SELL,
    sellTokenChainId: SupportedChainId.MAINNET,
    buyTokenChainId: 4663,
    buyTokenAddress: USDG_4663,
    buyTokenDecimals: 6,
    amount: 1_000_000n,
    ...overrides,
  }) as unknown as QuoteBridgeRequest

const USDC: TokenInfo = {
  chainId: 1,
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  symbol: 'USDC',
  decimals: 6,
}
const USDG_MAINNET: TokenInfo = {
  chainId: 1,
  address: '0xe343167631d89B6Ffc58B88d6b7fB0228795491D',
  symbol: 'USDG-MAINNET',
  decimals: 6,
}
const BASE_USDC: TokenInfo = {
  chainId: 8453,
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  symbol: 'USDC',
  decimals: 6,
}
const USDT: TokenInfo = {
  chainId: 1,
  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  symbol: 'USDT',
  decimals: 6,
}
const POLYGON_USDT0: TokenInfo = {
  chainId: 137,
  address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  symbol: 'USDT0',
  decimals: 6,
}
// Tether's USDT on Arbitrum (on-chain symbol USD₮0, 6 decimals, read 2026-10-15): not on the Ophis list.
const ARBITRUM_USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
// The Ophis list's own entries for these tokens (public/token-lists/ophis.json).
const TRUSTED: TokenInfo[] = [
  USDC,
  USDT,
  BASE_USDC,
  POLYGON_USDT0,
  { chainId: 4663, address: USDG_4663, symbol: 'USDG', decimals: 6 },
]

// Typed seams onto the protected AcrossApi and CoW Shed SDK so their calls can
// be stubbed without an `as any`. The SDK does not export the AcrossApi class
// name, so expose only the method the tests stub. `trusted` stands in for the
// Ophis token list; undefined loads the real one through fetch.
class TestableAcrossProvider extends OphisAcrossBridgeProvider {
  trusted: TokenInfo[] | undefined = TRUSTED

  get testApi(): { getSupportedTokens(): Promise<TokenInfo[]> } {
    return this.api
  }

  get testShed(): CowShedSdk {
    return this.cowShedSdk
  }

  protected trustedTokens(): Promise<TokenInfo[]> {
    return this.trusted ? Promise.resolve(this.trusted) : super.trustedTokens()
  }
}

describe('ophisBridgeProviders', () => {
  describe('OphisAcrossBridgeProvider', () => {
    it('extends the upstream network list with the probed-supported Ophis chains', async () => {
      const base = await new AcrossBridgeProvider().getNetworks()
      const extended = await new OphisAcrossBridgeProvider().getNetworks()

      expect(ids(extended)).toEqual(expect.arrayContaining(ids(base)))
      // Avalanche, BNB, Plasma, Ink, Linea, Unichain, Robinhood Chain
      expect(ids(extended)).toEqual(expect.arrayContaining([43114, 56, 9745, 57073, 59144, 130, 4663]))
      // Across has no Gnosis support (verified live 2026-08-10) — must NOT appear
      expect(ids(extended)).not.toContain(100)
    })

    it('has no duplicate chain ids', async () => {
      const extended = ids(await new OphisAcrossBridgeProvider().getNetworks())
      expect(new Set(extended).size).toBe(extended.length)
    })

    describe('getBuyTokens source gating', () => {
      const upstreamResult = { tokens: [], isRouteAvailable: true }

      afterEach(() => jest.restoreAllMocks())

      it('reports unavailable without hitting the API when the sell chain is not an executable Across source', async () => {
        const upstreamSpy = jest.spyOn(AcrossBridgeProvider.prototype, 'getBuyTokens').mockResolvedValue(upstreamResult)

        // Gnosis -> Robinhood Chain: Across is the only provider serving the
        // destination but cannot execute from the source — must not report
        // route availability (the chain chip would light with dead quotes).
        const result = await new OphisAcrossBridgeProvider().getBuyTokens({
          buyChainId: ROBINHOOD_CHAIN_ID,
          sellChainId: SupportedChainId.GNOSIS_CHAIN,
        })

        expect(result).toEqual({ tokens: [], isRouteAvailable: false })
        expect(upstreamSpy).not.toHaveBeenCalled()
      })

      it('delegates to the upstream implementation for executable sources', async () => {
        const upstreamSpy = jest.spyOn(AcrossBridgeProvider.prototype, 'getBuyTokens').mockResolvedValue(upstreamResult)

        const result = await new OphisAcrossBridgeProvider().getBuyTokens({
          buyChainId: ROBINHOOD_CHAIN_ID,
          sellChainId: SupportedChainId.MAINNET,
        })

        expect(result).toBe(upstreamResult)
        expect(upstreamSpy).toHaveBeenCalledTimes(1)
      })
    })

    describe('getIntermediateTokens route-based fallback', () => {
      const mockRoutes = (routes: unknown): jest.SpyInstance =>
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => routes } as Response)
      // The SDK validates every route's shape (the real API returns all of these).
      const route = (originToken: string, originTokenSymbol: string): Record<string, unknown> => ({
        originChainId: 1,
        originToken,
        originTokenSymbol,
        destinationChainId: 4663,
        destinationToken: acrossRequest().buyTokenAddress,
        destinationTokenSymbol: 'USDG',
        isNative: false,
      })

      afterEach(() => {
        jest.restoreAllMocks()
        jest.useRealTimers()
      })

      it('returns [] for a non-executable source without hitting super or the API', async () => {
        const superSpy = jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens')
        const fetchSpy = jest.spyOn(global, 'fetch')

        const result = await new OphisAcrossBridgeProvider().getIntermediateTokens(
          acrossRequest({ sellTokenChainId: SupportedChainId.POLYGON }),
        )

        expect(result).toEqual([])
        expect(superSpy).not.toHaveBeenCalled()
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('uses a non-empty symbol match without a route fetch', async () => {
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([USDC])
        const fetchSpy = jest.spyOn(global, 'fetch')

        const result = await new TestableAcrossProvider().getIntermediateTokens(
          acrossRequest({ buyTokenChainId: SupportedChainId.BASE, buyTokenAddress: BASE_USDC.address }),
        )

        expect(result).toEqual([USDC])
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('falls back to Across available-routes when the symbol match is empty (the USDG corridor)', async () => {
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
        const fetchSpy = mockRoutes([
          route(USDC.address, 'USDC'), // cross-asset USDC -> USDG
          route(USDG_MAINNET.address, 'USDG'), // chain-aliased USDG-MAINNET -> USDG
        ])
        const provider = new TestableAcrossProvider({ apiOptions: { apiKey: 'test-key', integratorId: '0x0311' } })
        jest.spyOn(provider.testApi, 'getSupportedTokens').mockResolvedValue([USDC, USDG_MAINNET, BASE_USDC])

        const result = await provider.getIntermediateTokens(acrossRequest())

        // The pinned USDC -> USDG pair passes; USDG-MAINNET is not on the Ophis
        // list (dropped until it is), and the Base USDC (wrong chain) is excluded.
        expect(result).toEqual([USDC])
        const [url, init] = fetchSpy.mock.calls[0] // attributed, authenticated, abortable
        expect(String(url)).toContain('/available-routes?')
        expect(new URL(String(url)).searchParams.get('integratorId')).toBe('0x0311')
        expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' })
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      })

      it('aborts a stalled route request at the timeout and degrades to []', async () => {
        jest.useFakeTimers()
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
        const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((_url, init) => settleOnlyOnAbort(init?.signal))
        const pending = new OphisAcrossBridgeProvider().getIntermediateTokens(acrossRequest())
        await jest.advanceTimersByTimeAsync(10_001)
        expect(await pending).toEqual([])
        expect(fetchSpy.mock.calls[0][1]?.signal?.aborted).toBe(true)
      })

      it('returns [] when the route fetch fails (no crash, corridor just unavailable)', async () => {
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
        jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))

        const result = await new OphisAcrossBridgeProvider().getIntermediateTokens(acrossRequest())

        expect(result).toEqual([])
      })

      it('degrades to [] on a malformed routes response instead of crashing the quote', async () => {
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
        // null entries + a non-string originToken would throw if unguarded
        mockRoutes([null, { originToken: 12345 }, { notOrigin: 'x' }])

        const result = await new OphisAcrossBridgeProvider().getIntermediateTokens(acrossRequest())

        expect(result).toEqual([])
      })
    })

    describe('getQuote fee request (sdk-bridging patch: explicit inputToken/outputToken)', () => {
      // Across's legacy single `token` param resolves the destination token by
      // symbol, so every cross-asset (USDC -> USDG) or chain-aliased
      // (USDG-MAINNET -> USDG) corridor into Robinhood Chain answered 400
      // "Unsupported token address on given destination chain" and the UI showed
      // the generic "Error loading price" for ANY sell token (reproduced live
      // 2026-09-10). The patch sends the explicit pair, which is also what the
      // deposit hook already passes to depositV3 as outputToken. Runs against the
      // installed (patched) package: it FAILS if the patch hunk is lost on an SDK
      // bump, and it cannot pass by accident since unpatched code never emits
      // `inputToken`.
      const SUGGESTED_FEES = {
        estimatedFillTimeSec: 2,
        timestamp: '1789041275',
        isAmountTooLow: false,
        quoteBlock: '25946820',
        spokePoolAddress: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
        exclusiveRelayer: '0x0000000000000000000000000000000000000000',
        exclusivityDeadline: 0,
        fillDeadline: '1789048715',
        totalRelayFee: { pct: '1162680000000000', total: '116268' },
        relayerCapitalFee: { pct: '100000000000000', total: '10000' },
        relayerGasFee: { pct: '462680000000000', total: '46268' },
        lpFee: { pct: '0', total: '0' },
        limits: {
          minDeposit: '500033',
          maxDeposit: '114824679856',
          maxDepositInstant: '114824679856',
          maxDepositShortDelay: '114824679856',
          recommendedDepositInstant: '114824679856',
        },
      }

      afterEach(() => jest.restoreAllMocks())

      it('quotes the cross-asset USDC -> Robinhood USDG corridor with inputToken + outputToken, never the legacy token param', async () => {
        const fetchSpy = jest
          .spyOn(global, 'fetch')
          .mockResolvedValue({ ok: true, json: async () => SUGGESTED_FEES } as Response)

        const quote = await new TestableAcrossProvider().getQuote(
          acrossRequest({
            sellTokenAddress: USDC.address,
            sellTokenDecimals: 6,
            buyTokenDecimals: 6,
            amount: 100_000_000n,
          }),
        )

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
        expect(url.pathname).toMatch(/\/suggested-fees$/)
        expect(url.searchParams.get('inputToken')).toBe(USDC.address)
        expect(url.searchParams.get('outputToken')).toBe(USDG_4663)
        expect(url.searchParams.get('originChainId')).toBe('1')
        expect(url.searchParams.get('destinationChainId')).toBe('4663')
        expect(url.searchParams.get('amount')).toBe('100000000')
        expect(url.searchParams.has('token')).toBe(false)
        // The response flowed through the SDK's quote mapping: 100 USDC minus the
        // 0.116268% relay fee (1e18-scaled pct) = 99.883732 USDG.
        expect(quote.amountsAndCosts.afterFee.buyAmount).toBe(99_883_732n)
        // The minimum shown keeps the 0.1% room placement allows the fee to rise by (0.1 USDG here).
        expect(quote.amountsAndCosts.afterSlippage.buyAmount).toBe(99_783_732n)
      })

      it('refuses a cross-decimal route before any fee request (deposit outputAmount is computed in sell-token units)', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch')
        // Across lists USDC (6) -> USDC-BNB (18) on BNB; the 400 on the legacy
        // `token` param used to make it unquotable by accident. The on-chain
        // deposit would offer 100e6 input for ~1e-10 output, so it must stay
        // unquotable on purpose.
        const USDC_BNB = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'

        await expect(
          new TestableAcrossProvider().getQuote(
            acrossRequest({
              sellTokenAddress: USDC.address,
              sellTokenDecimals: 6,
              buyTokenChainId: SupportedChainId.BNB,
              buyTokenAddress: USDC_BNB,
              buyTokenDecimals: 18,
              amount: 100_000_000n,
            }),
          ),
        ).rejects.toMatchObject({ message: BridgeQuoteErrors.NO_ROUTES })
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('refuses an intermediate that never came through getIntermediateTokens, before any fee request', async () => {
        // The SDK's shared intermediate cache can hand getQuote a token another tab
        // or an older build picked: here one off the Ophis list and a listed token
        // of another asset, both bridging into Robinhood USDG.
        const fetchSpy = jest.spyOn(global, 'fetch')
        const getIntermediateSpy = jest.spyOn(OphisAcrossBridgeProvider.prototype, 'getIntermediateTokens')
        const provider = new TestableAcrossProvider()

        for (const cached of [USDG_MAINNET, USDT]) {
          await expect(
            provider.getQuote(acrossRequest({ sellTokenAddress: cached.address, sellTokenDecimals: 6 })),
          ).rejects.toMatchObject({ message: BridgeQuoteErrors.NO_ROUTES })
        }
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(getIntermediateSpy).not.toHaveBeenCalled()
      })
    })
  })
})

// The order buys the intermediate, and Across's own token list picks it: only
// tokens the Ophis list (or the pinned wrapped gas token) vouches for, as the
// same asset as the destination, may come out.
describe('OphisAcrossBridgeProvider: trusted same-asset intermediates', () => {
  const ARBITRUM_WETH = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.ARBITRUM_ONE]
  const BASE_WETH = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.BASE]
  // The Ophis list's BNB USDC (18 decimals) and Unichain USDG entries.
  const BNB_USDC: TokenInfo = {
    chainId: 56,
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    decimals: 18,
  }
  const UNICHAIN_USDG: TokenInfo = {
    chainId: 130,
    address: '0x2A22868610610199D43fE93A16661473A9f86f1E',
    symbol: 'USDG',
    decimals: 6,
  }
  const toBaseUsdc = { buyTokenChainId: SupportedChainId.BASE, buyTokenAddress: BASE_USDC.address }
  const toPolygonUsdt0 = { buyTokenChainId: SupportedChainId.POLYGON, buyTokenAddress: POLYGON_USDT0.address }

  // Stubs Across's symbol match with `candidates`, then asks for intermediates.
  const intermediates = (
    candidates: TokenInfo[],
    overrides: Partial<QuoteBridgeRequest>,
    provider = new TestableAcrossProvider(),
  ): Promise<TokenInfo[]> => {
    jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue(candidates)
    return provider.getIntermediateTokens(acrossRequest(overrides))
  }
  const withTrusted = (trusted: TokenInfo[] | undefined): TestableAcrossProvider =>
    Object.assign(new TestableAcrossProvider(), { trusted })

  afterEach(() => jest.restoreAllMocks())

  it('drops a candidate the Ophis list does not have, whatever symbol Across gives it', async () => {
    expect(await intermediates([{ ...USDG_MAINNET, symbol: 'USDC' }, USDC], toBaseUsdc)).toEqual([USDC])
  })

  it('drops a listed token that is another asset than the destination', async () => {
    expect(await intermediates([USDC], toPolygonUsdt0)).toEqual([])
  })

  it('reads USDT0 as USDT, so mainnet USDT bridges into Polygon USDT0', async () => {
    expect(await intermediates([USDC, USDT], toPolygonUsdt0)).toEqual([USDT])
  })

  it('takes decimals from the Ophis list, never from Across', async () => {
    expect(await intermediates([{ ...USDC, decimals: 18 }], toBaseUsdc)).toEqual([USDC])
    const toBnbUsdc = { buyTokenChainId: SupportedChainId.BNB, buyTokenAddress: BNB_USDC.address, buyTokenDecimals: 18 }
    expect(await intermediates([{ ...USDC, decimals: 18 }], toBnbUsdc, withTrusted([...TRUSTED, BNB_USDC]))).toEqual([])
  })

  it('requires a trusted destination, with the decimals the swap form quotes', async () => {
    const toArbitrumUsdt = { buyTokenChainId: SupportedChainId.ARBITRUM_ONE, buyTokenAddress: ARBITRUM_USDT }
    expect(await intermediates([USDT], toArbitrumUsdt)).toEqual([])
    expect(await intermediates([USDC], { buyTokenDecimals: 18 })).toEqual([])
  })

  it('trusts the pinned wrapped gas token: Arbitrum WETH -> Base WETH, neither on the list', async () => {
    const acrossWeth: TokenInfo = { chainId: 42161, address: ARBITRUM_WETH.address, symbol: 'ETH', decimals: 18 }
    const arbitrumToBaseWeth = {
      sellTokenChainId: SupportedChainId.ARBITRUM_ONE,
      buyTokenChainId: SupportedChainId.BASE,
      buyTokenAddress: BASE_WETH.address,
      buyTokenDecimals: 18,
    }

    expect(await intermediates([acrossWeth], arbitrumToBaseWeth)).toEqual([
      { chainId: 42161, address: ARBITRUM_WETH.address, decimals: 18, symbol: 'WETH', name: 'Wrapped Ether' },
    ])
  })

  it("reads ETH as WETH, so WETH bridges into BNB Chain's Binance-Peg Ethereum", async () => {
    // The Ophis list keeps the BNB token's on-chain symbol, ETH.
    const BNB_ETH: TokenInfo = {
      chainId: 56,
      address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
      symbol: 'ETH',
      decimals: 18,
    }
    const weth = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.MAINNET]
    const toBnbEth = { buyTokenChainId: SupportedChainId.BNB, buyTokenAddress: BNB_ETH.address, buyTokenDecimals: 18 }
    const candidate: TokenInfo = { chainId: 1, address: weth.address, symbol: 'WETH', decimals: 18 }

    expect(await intermediates([candidate], toBnbEth, withTrusted([...TRUSTED, BNB_ETH]))).toEqual([
      { chainId: 1, address: weth.address, decimals: 18, symbol: 'WETH', name: 'Wrapped Ether' },
    ])
  })

  it('allows USDC into USDG only on Robinhood Chain', async () => {
    expect(await intermediates([USDC], {})).toEqual([USDC])
    const toUnichainUsdg = { buyTokenChainId: 130 as unknown as TargetChainId, buyTokenAddress: UNICHAIN_USDG.address }
    expect(await intermediates([USDC], toUnichainUsdg, withTrusted([...TRUSTED, UNICHAIN_USDG]))).toEqual([])
  })

  it('loads the Ophis list once per provider, failing closed until it loads', async () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '../../public/token-lists/ophis.json'), 'utf8'))
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, json: async () => shipped } as Response)
    const provider = withTrusted(undefined)

    expect(await intermediates([USDC], {}, provider)).toEqual([])
    // Retried after the failure; the shipped list carries the USDC -> USDG pair.
    expect(await intermediates([USDC], {}, provider)).toEqual([{ ...USDC, name: 'USD Coin' }])
    expect(await intermediates([USDC], {}, provider)).toEqual([{ ...USDC, name: 'USD Coin' }])
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([OPHIS_TOKENS_LIST_SOURCE, OPHIS_TOKENS_LIST_SOURCE])
  })
})

// Shared by the Across placement tests below. Placeholders: only the stubbed SDK calls ever see them.
const SHED = `0x${'5e'.repeat(20)}`
const FACTORY = `0x${'fa'.repeat(20)}`
// The order owner: a real key, since the hook's signature is checked as the shed checks it.
const OWNER_KEY = new Wallet(`0x${'0a'.repeat(32)}`)
const OWNER = OWNER_KEY.address as `0x${string}`
// The shed factory call carrying a hook, signed by `key` over the SDK's own typed data for SHED.
const SHED_FACTORY_CALLS = new Interface([
  'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)',
])
async function signedHook(
  key: Wallet,
  { calls, chainId, nonce, deadline }: { calls: unknown[]; chainId: SupportedChainId; nonce: string; deadline: bigint },
  user: string = OWNER,
): Promise<string> {
  const { domain, types, message } = new CowShedHooks(chainId).infoToSign(calls as never, nonce, deadline, SHED)
  const signature = await key._signTypedData(domain, types as never, message)
  return SHED_FACTORY_CALLS.encodeFunctionData('executeHooks', [calls, nonce, deadline, user, signature])
}
const PROGRAM: EvmCall = { to: `0x${'9e'.repeat(20)}`, data: '0x1234', value: 0n }
const NONCE = `0x${'0'.repeat(64)}`
// The recorded suggested-fees above: fillDeadline 7440 s after the quote time.
const QUOTE_TIME = 1_789_041_275n
const PCT = 10n ** 15n // a 0.1% relay fee (1e18 = 100%)
type Fees = { fillDeadline?: bigint; pct?: bigint; timestamp?: bigint; exclusivity?: bigint; relayer?: string }
// The global adapter stands in for the wallet (who signs), the ERC-20 contract for the shed's balance.
const signerOf = (address: string): SignerLike => ({ getAddress: async () => address }) as unknown as SignerLike
// The Across quote the user confirmed, as the trade flows hand it to placeConfirmed.
const confirmedQuote = (pct: bigint): BridgeQuoteResults =>
  ({
    providerInfo: new AcrossBridgeProvider().info,
    quoteBody: JSON.stringify({ totalRelayFee: { pct: String(pct) } }),
  }) as BridgeQuoteResults
// A browser's Web Locks, granting every request (placement needs them).
const grantLocks = (): void => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({}) },
  })
}

const feesQuote = ({
  fillDeadline = QUOTE_TIME + 7_440n,
  pct = PCT,
  timestamp = QUOTE_TIME,
  exclusivity = 0n,
  relayer = `0x${'0'.repeat(40)}`,
}: Fees = {}): AcrossQuoteResult =>
  ({
    suggestedFees: {
      timestamp: String(timestamp),
      fillDeadline: String(fillDeadline),
      totalRelayFee: { pct: String(pct) },
      exclusivityDeadline: Number(exclusivity),
      exclusiveRelayer: relayer,
    },
  }) as unknown as AcrossQuoteResult
type SignHookOptions = Fees & {
  signer?: SignerLike
  account?: string
  amount?: bigint
  receiver?: string
  confirmed?: bigint | null
}
interface GuardedSetup {
  shedBalance: jest.Mock
  openOrders: jest.Mock
  word: (hex: string) => string
  setLocalClock: (seconds: bigint) => void
  guardedProvider: (ordersOf?: jest.Mock | null) => { provider: TestableAcrossProvider; signCalls: jest.SpyInstance }
  signHook: (provider: TestableAcrossProvider, deadline: bigint, options?: SignHookOptions) => Promise<BridgeHook>
}

// The stubbed SDK, wallet, chain and orderbook the Across placement tests run against, with their hooks.
function guardedSetup(): GuardedSetup {
  const word = (hex: string): string => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  const shedBalance = jest.fn()
  // The wallet's orders on the orderbook: none open by default.
  const openOrders = jest.fn()
  const setLocalClock = (seconds: bigint): void => {
    jest.spyOn(Date, 'now').mockReturnValue(Number(seconds) * 1000)
  }

  // null: no orderbook wired.
  function guardedProvider(ordersOf: typeof openOrders | null = openOrders): {
    provider: TestableAcrossProvider
    signCalls: jest.SpyInstance
  } {
    jest.spyOn(AcrossBridgeProvider.prototype, 'getUnsignedBridgeCall').mockImplementation(async () => ({ ...PROGRAM }))
    const provider = new TestableAcrossProvider({ ordersOf: ordersOf ?? undefined })
    jest.spyOn(provider.testShed, 'getCowShedAccount').mockReturnValue(SHED)
    const signCalls = jest.spyOn(provider.testShed, 'signCalls').mockImplementation(async (request) => ({
      signedMulticall: { to: FACTORY, data: await signedHook(OWNER_KEY, request as never), value: 0n },
      cowShedAccount: SHED,
      gasLimit: 290_000n,
    }))
    return { provider, signCalls }
  }

  // Without a signer the SDK signs with the adapter's, the order owner here: placing the order, which the trade
  // flows do through placeConfirmed with the quote the user confirmed (null: none).
  async function signHook(
    provider: TestableAcrossProvider,
    deadline: bigint,
    { signer, account = OWNER, amount, receiver, confirmed = PCT, ...fees }: SignHookOptions = {},
  ): Promise<BridgeHook> {
    const request = acrossRequest({
      sellTokenAddress: USDC.address,
      account: account as QuoteBridgeRequest['account'],
      ...(amount && { amount }),
      ...(receiver && { receiver }),
    })
    const call = await provider.getUnsignedBridgeCall(request, feesQuote(fees))
    const sign = (): Promise<BridgeHook> =>
      provider.getSignedHook(SupportedChainId.MAINNET, call, NONCE, deadline, 290_000, signer)
    return signer || confirmed === null ? sign() : placeConfirmed(confirmedQuote(confirmed), account, sign)
  }

  beforeEach(() => {
    shedBalance.mockReset().mockResolvedValue(BigNumber.from(0))
    openOrders.mockReset().mockResolvedValue([])
    jest
      .spyOn(Erc20__factory, 'connect')
      .mockReturnValue({ balanceOf: shedBalance } as unknown as ReturnType<typeof Erc20__factory.connect>)
    setGlobalAdapter({
      signer: signerOf(OWNER),
      createSigner: (signer: SignerLike) => signer,
    } as unknown as AbstractProviderAdapter)
    setLocalClock(QUOTE_TIME)
    jest
      .spyOn(getRpcProvider(SupportedChainId.MAINNET), 'getBlock')
      .mockResolvedValue({ timestamp: Number(QUOTE_TIME) } as never)
    grantLocks()
    localStorage.clear()
    jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'getCode').mockResolvedValue('0x') // the owner: no contract
    // The shed's record of used nonces: the hooks placed earlier in a test have run.
    jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'call').mockResolvedValue(`0x${'0'.repeat(63)}1`)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Reflect.deleteProperty(navigator, 'locks')
  })

  return { shedBalance, openOrders, word, setLocalClock, guardedProvider, signHook }
}

describe('OphisAcrossBridgeProvider: guarded hook and Across deadlines', () => {
  const { shedBalance, word, setLocalClock, guardedProvider, signHook } = guardedSetup()

  it('signs the guard first, then the deposit program, and tags the factory calldata', async () => {
    const { provider, signCalls } = guardedProvider()
    const hook = await signHook(provider, QUOTE_TIME + 1_800n)

    expect(provider.testShed.getCowShedAccount).toHaveBeenCalledWith(SupportedChainId.MAINNET, OWNER)
    // transfer(shed, 1_000_000 less 0.1%): the shed pays itself, which reverts
    // while it holds less than the order's minimum output.
    const guard = `0xa9059cbb${word(SHED)}${word((999_000).toString(16))}`
    expect(signCalls).toHaveBeenCalledWith({
      calls: [
        { target: USDC.address, value: 0n, callData: guard, allowFailure: false, isDelegateCall: false },
        { target: PROGRAM.to, value: 0n, callData: PROGRAM.data, allowFailure: false, isDelegateCall: true },
      ],
      chainId: SupportedChainId.MAINNET,
      signer: undefined,
      gasLimit: 290_000n,
      deadline: QUOTE_TIME + 1_800n,
      nonce: NONCE,
    })
    // Upstream's postHook shape (dappId, recipient), with the integrator tag
    // ending the calldata on a 32-byte boundary.
    const tagged = hook.postHook.callData
    const { signedMulticall } = await signCalls.mock.results[0]?.value
    expect(tagged.startsWith(signedMulticall.data)).toBe(true)
    expect(tagged.endsWith('1dc0de0311')).toBe(true)
    expect(((tagged.length - 2) / 2) % 32).toBe(0)
    expect(hook).toEqual({
      postHook: {
        target: FACTORY,
        callData: tagged,
        gasLimit: '290000',
        dappId: new AcrossBridgeProvider().info.dappId,
      },
      recipient: SHED,
    })
  })

  it('refuses to sign a deposit call it did not build, which would carry no guard', async () => {
    const { provider, signCalls } = guardedProvider()

    await expect(
      provider.getSignedHook(SupportedChainId.MAINNET, { ...PROGRAM }, NONCE, QUOTE_TIME, 290_000),
    ).rejects.toThrow('not built by this provider')
    expect(signCalls).not.toHaveBeenCalled()
  })

  it('refuses a deadline by which the Across quote time is over 3600 s old, before any wallet prompt', async () => {
    const { provider, signCalls } = guardedProvider()

    const refused = await signHook(provider, QUOTE_TIME + 3_601n).then(
      () => new Error('signed'),
      (error: Error) => error,
    )
    // The swap flow shows the message as is.
    expect(getSwapErrorMessage(refused)).toBe('The bridge quote changed while placing the order. Please try again.')
    expect(signCalls).not.toHaveBeenCalled()
    await expect(signHook(provider, QUOTE_TIME + 3_600n)).resolves.toMatchObject({ recipient: SHED })
  })

  it('refuses a deadline less than 15 minutes before the Across fill deadline', async () => {
    const { provider, signCalls } = guardedProvider()
    const fillDeadline = QUOTE_TIME + 3_000n

    await expect(signHook(provider, fillDeadline - 899n, { fillDeadline })).rejects.toThrow('bridge quote changed')
    expect(signCalls).not.toHaveBeenCalled()
    await expect(signHook(provider, fillDeadline - 900n, { fillDeadline })).resolves.toMatchObject({ recipient: SHED })
  })

  it('still signs the quoting hook when the local clock runs half an hour fast', async () => {
    const { provider, signCalls } = guardedProvider()
    // The SDK's quoting deadline is local time + validFor (1800 s), here 3700 s
    // past the Across quote time. The app signs it with its own quote account,
    // which with no wallet connected is also the placeholder owner.
    const late = QUOTE_TIME + 1_900n + 1_800n
    setLocalClock(QUOTE_TIME + 1_900n)

    await expect(signHook(provider, late, { signer: signerOf(BRIDGE_QUOTE_ACCOUNT) })).resolves.toMatchObject({
      recipient: SHED,
    })
    await expect(
      signHook(provider, late, { signer: signerOf(BRIDGE_QUOTE_ACCOUNT), account: BRIDGE_QUOTE_ACCOUNT }),
    ).resolves.toMatchObject({ recipient: SHED })
    expect(signCalls).toHaveBeenCalledTimes(2)
    // Placed by the owner, that deadline is refused: the swap flow never sends one (acrossValidToLimit).
    await expect(signHook(provider, late)).rejects.toThrow('bridge quote changed')
  })

  it('checks a placement at the default 30 minute deadline against the sell chain clock and the deposit buffers', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n // local time + validFor, as the quoting hook carries too

    // Relayers would get under 15 minutes after the order's deadline.
    await expect(signHook(provider, deadline, { fillDeadline: deadline + 899n })).rejects.toThrow(
      'bridge quote changed',
    )
    // A quote time the chain has not reached, or a fill deadline past its 6 hour buffer: the deposit reverts.
    await expect(signHook(provider, deadline, { timestamp: QUOTE_TIME + 1n })).rejects.toThrow('bridge quote changed')
    await expect(signHook(provider, deadline, { fillDeadline: QUOTE_TIME + 21_601n })).rejects.toThrow(
      'bridge quote changed',
    )
    expect(signCalls).not.toHaveBeenCalled()
    await expect(signHook(provider, deadline, { fillDeadline: QUOTE_TIME + 21_600n })).resolves.toMatchObject({
      recipient: SHED,
    })
  })

  it('refuses exclusivity the deposit cannot keep: over 5 minutes, or for no named relayer', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n
    const relayer = `0x${'7e'.repeat(20)}`

    // Across sends it as an offset, or (above a year) as a timestamp.
    for (const exclusivity of [301n, QUOTE_TIME + 301n]) {
      await expect(signHook(provider, deadline, { exclusivity, relayer })).rejects.toThrow('bridge quote changed')
    }
    await expect(signHook(provider, deadline, { exclusivity: 300n })).rejects.toThrow('bridge quote changed')
    expect(signCalls).not.toHaveBeenCalled()
    for (const exclusivity of [300n, QUOTE_TIME + 300n]) {
      await expect(signHook(provider, deadline, { exclusivity, relayer })).resolves.toMatchObject({ recipient: SHED })
    }
  })

  it('refuses a placement re-quote whose fee is over 0.1% above the quote confirmed, or with none confirmed', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n

    await expect(signHook(provider, deadline, { pct: PCT + 10n ** 15n + 1n })).rejects.toThrow('bridge quote changed')
    await expect(signHook(provider, deadline, { pct: 10n ** 18n - 10n ** 15n })).rejects.toThrow('bridge quote changed')
    await expect(signHook(provider, deadline, { confirmed: null })).rejects.toThrow('bridge quote changed')
    expect(signCalls).not.toHaveBeenCalled()
    await expect(signHook(provider, deadline, { pct: PCT + 10n ** 15n })).resolves.toMatchObject({ recipient: SHED })
  })

  it('holds placement to the quote confirmed, whatever quotes came since, for that placement only', async () => {
    const { provider } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n
    // A fee that rose before the user confirmed it: placed at it.
    await expect(signHook(provider, deadline, { confirmed: 4n * PCT, pct: 4n * PCT })).resolves.toMatchObject({
      recipient: SHED,
    })
    // Quotes keep coming while the user confirms 0.1%: one at 0.4% signed meanwhile does not raise the bound.
    await signHook(provider, deadline, { signer: signerOf(BRIDGE_QUOTE_ACCOUNT), pct: 4n * PCT })
    await expect(signHook(provider, deadline, { pct: 4n * PCT })).rejects.toThrow('bridge quote changed')
    // A placement that fails before its hook leaves no confirmation behind for the next one.
    await expect(
      placeConfirmed(confirmedQuote(4n * PCT), OWNER, () => Promise.reject(new Error('declined'))),
    ).rejects.toThrow('declined')
    await expect(signHook(provider, deadline, { confirmed: null })).rejects.toThrow('bridge quote changed')
    // One confirmation, one placement: a second hook signed within it is refused.
    const call = await provider.getUnsignedBridgeCall(
      acrossRequest({ sellTokenAddress: USDC.address, account: OWNER }),
      feesQuote(),
    )
    const sign = (): Promise<BridgeHook> =>
      provider.getSignedHook(SupportedChainId.MAINNET, call, NONCE, deadline, 290_000)
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, () => sign().then(sign))).rejects.toThrow(
      'bridge quote changed',
    )
  })

  it('refuses any leftover in the shed when the bridge pays someone else, who would receive it', async () => {
    const { provider, signCalls } = guardedProvider()
    shedBalance.mockResolvedValue(BigNumber.from(1))

    await expect(signHook(provider, QUOTE_TIME + 1_800n, { receiver: `0x${'0c'.repeat(20)}` })).rejects.toThrow(
      'already holds this bridge token',
    )
    expect(signCalls).not.toHaveBeenCalled()
    await expect(signHook(provider, QUOTE_TIME + 1_800n, { receiver: OWNER })).resolves.toMatchObject({
      recipient: SHED,
    })
  })

  it('places a forced 60 minute deadline once acrossValidToLimit caps it', async () => {
    const { provider, signCalls } = guardedProvider()
    const now = QUOTE_TIME + 60n
    setLocalClock(now)
    const bridgeQuote = {
      providerInfo: new AcrossBridgeProvider().info,
      quoteTimestamp: Number(QUOTE_TIME),
      quoteBody: JSON.stringify(feesQuote().suggestedFees),
    } as BridgeQuoteResults
    const forced = now + 3_600n

    await expect(signHook(provider, forced)).rejects.toThrow('bridge quote changed')
    const capped = BigInt(Math.min(Number(forced), acrossValidToLimit(bridgeQuote)))
    expect(capped).toBe(QUOTE_TIME + 3_300n)
    await expect(signHook(provider, capped)).resolves.toMatchObject({ recipient: SHED })
    expect(signCalls).toHaveBeenCalledTimes(1)
  })

  it('places over dust in the shed, which anyone can send and which is bridged along', async () => {
    const { provider, signCalls } = guardedProvider()
    // The guard asks for 999000; a leftover under a tenth of it cannot let an early run pass cheaply.
    shedBalance.mockResolvedValue(BigNumber.from(99_899))

    await expect(signHook(provider, QUOTE_TIME + 1_800n)).resolves.toMatchObject({ recipient: SHED })
    expect(signCalls).toHaveBeenCalledTimes(1)
  })

  it('refuses to place while the shed already holds a tenth of the guard, pointing to the recover page', async () => {
    const { provider, signCalls } = guardedProvider()
    // USDC left by an earlier bridge whose deposit expired or never ran: a tenth of the guard (999000).
    shedBalance.mockResolvedValue(BigNumber.from(99_900))

    const refused = await signHook(provider, QUOTE_TIME + 1_800n).then(
      () => new Error('signed'),
      (error: Error) => error,
    )
    expect(getSwapErrorMessage(refused)).toBe(
      'Your Account Proxy already holds this bridge token from an earlier bridge. Recover it under Account > Account Proxy (select the proxy, then the token, then Recover funds) and try again.',
    )
    // On the sell chain's RPC, whichever chain the global adapter is on.
    expect(Erc20__factory.connect).toHaveBeenCalledWith(USDC.address, getRpcProvider(SupportedChainId.MAINNET))
    expect(shedBalance).toHaveBeenCalledWith(SHED)
    expect(signCalls).not.toHaveBeenCalled()
  })

  it('reads no shed balance for the quoting hook signed by the app quote account, and refuses any other signer', async () => {
    const { provider, signCalls } = guardedProvider()
    shedBalance.mockResolvedValue(BigNumber.from(1))

    await expect(
      signHook(provider, QUOTE_TIME + 1_800n, { signer: signerOf(BRIDGE_QUOTE_ACCOUNT) }),
    ).resolves.toMatchObject({ recipient: SHED })
    expect(shedBalance).not.toHaveBeenCalled()
    // Neither the quote account nor the owner: its hook would not verify for the owner's shed.
    signCalls.mockClear()
    await expect(signHook(provider, QUOTE_TIME + 1_800n, { signer: signerOf(`0x${'0b'.repeat(20)}`) })).rejects.toThrow(
      'signed by the wallet placing the order',
    )
    expect(signCalls).not.toHaveBeenCalled()
  })
})

describe('OphisAcrossBridgeProvider: other bridges of the wallet', () => {
  const { openOrders, guardedProvider, signHook } = guardedSetup()

  it('refuses to place while an earlier bridge of the wallet could still run its signed hook', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n
    const SHED_FACTORY = new Interface([
      'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)',
    ])
    const NONCE_A = `0x${'a1'.repeat(32)}`
    // The posted hook: the factory call with the deadline it was signed with, then the Across integrator tag.
    const hook = (until: bigint): string =>
      `${SHED_FACTORY.encodeFunctionData('executeHooks', [[], NONCE_A, until, OWNER, '0x'])}${'0'.repeat(54)}1dc0de0311`
    const earlier = (
      status: OrderStatus,
      until = QUOTE_TIME + 600n,
      signingScheme = SigningScheme.EIP712,
    ): unknown => ({
      uid: `0x${'e1'.repeat(56)}`,
      status,
      signingScheme,
      receiver: SHED,
      validTo: 4_294_967_295, // a native ETH order's: the hook's deadline is the real one
      fullAppData: JSON.stringify({ metadata: { hooks: { post: [{ callData: hook(until) }] } } }),
    })
    const nonces = jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'call')

    // A cancelled or filled order's hook, unused and not expired: run after this order's payout, it would carry it.
    for (const status of [OrderStatus.CANCELLED, OrderStatus.FULFILLED, OrderStatus.EXPIRED]) {
      openOrders.mockResolvedValueOnce([earlier(status)])
      nonces.mockResolvedValueOnce(`0x${'0'.repeat(64)}`)
      await expect(signHook(provider, deadline)).rejects.toThrow('could still run')
    }
    openOrders.mockResolvedValueOnce([earlier(OrderStatus.CANCELLED)])
    nonces.mockRejectedValueOnce(new Error('rpc down'))
    await expect(signHook(provider, deadline)).rejects.toThrow('Could not check')
    expect(signCalls).not.toHaveBeenCalled()
    // Its nonce used: placed.
    openOrders.mockResolvedValueOnce([earlier(OrderStatus.CANCELLED)])
    nonces.mockResolvedValueOnce(`0x${'0'.repeat(63)}1`)
    await expect(signHook(provider, deadline)).resolves.toMatchObject({ recipient: SHED })
    expect(nonces).toHaveBeenLastCalledWith({ to: SHED, data: expect.stringContaining(NONCE_A.slice(2)) })
    // Its hook expired (an expired native bridge), or a pre-sign order anyone can list "from" the wallet, pending
    // or let expire: not even read.
    nonces.mockClear()
    openOrders.mockResolvedValueOnce([
      earlier(OrderStatus.EXPIRED, QUOTE_TIME),
      earlier(OrderStatus.PRESIGNATURE_PENDING),
      earlier(OrderStatus.EXPIRED, QUOTE_TIME + 600n, SigningScheme.PRESIGN),
    ])
    await expect(signHook(provider, deadline)).resolves.toMatchObject({ recipient: SHED })
    expect(nonces).not.toHaveBeenCalledWith({ to: SHED, data: expect.stringContaining(NONCE_A.slice(2)) })
  })

  it('refuses to place while a hook this browser placed can still run, whatever the orderbook lists', async () => {
    const { provider } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n
    const nonces = jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'call')
    const unused = `0x${'0'.repeat(64)}`
    // A placed bridge the orderbook does not show (a native one before it is mined, or pushed out by spam).
    await signHook(provider, deadline)
    nonces.mockResolvedValueOnce(unused)
    await expect(signHook(provider, deadline)).rejects.toThrow('could still run')
    expect(nonces).toHaveBeenLastCalledWith({ to: SHED, data: expect.stringContaining(NONCE.slice(2)) })
    // Once its nonce is used it blocks nothing: placement proceeds, and records its own hook.
    const stored = (): unknown => JSON.parse(localStorage.getItem(`ophisBridgeHooks:v0:${OWNER.toLowerCase()}`) ?? '[]')
    await expect(signHook(provider, deadline)).resolves.toMatchObject({ recipient: SHED })
    expect(stored()).toEqual([{ chainId: SupportedChainId.MAINNET, nonce: NONCE, deadline: String(deadline) }])
    // An expired record, or one for another chain, is not read; only the latter is kept. A used one is read and kept
    // until its deadline: a reorg could undo that use.
    const [expired, base, ran] = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`, `0x${'cc'.repeat(32)}`]
    const ranHook = { chainId: SupportedChainId.MAINNET, nonce: ran, deadline: String(QUOTE_TIME + 999n) }
    localStorage.setItem(
      `ophisBridgeHooks:v0:${OWNER.toLowerCase()}`,
      JSON.stringify([
        { chainId: SupportedChainId.MAINNET, nonce: expired, deadline: String(QUOTE_TIME) },
        { chainId: SupportedChainId.BASE, nonce: base, deadline: String(QUOTE_TIME + 999n) },
        ranHook,
      ]),
    )
    nonces.mockClear()
    await expect(signHook(provider, deadline)).resolves.toMatchObject({ recipient: SHED })
    expect(nonces).toHaveBeenCalledTimes(1)
    expect(nonces).toHaveBeenCalledWith({ to: SHED, data: expect.stringContaining(ran.slice(2)) })
    expect(stored()).toEqual([
      { chainId: SupportedChainId.BASE, nonce: base, deadline: String(QUOTE_TIME + 999n) },
      ranHook,
      { chainId: SupportedChainId.MAINNET, nonce: NONCE, deadline: String(deadline) },
    ])
  })

  it('remembers a hook once signed, even if its order is then declined or lost, and refuses if it cannot', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n
    const stored = (owner: string = OWNER): unknown =>
      JSON.parse(localStorage.getItem(`ophisBridgeHooks:v0:${owner.toLowerCase()}`) ?? '[]')
    const hook = { chainId: SupportedChainId.MAINNET, nonce: NONCE, deadline: String(deadline) }
    const call = await provider.getUnsignedBridgeCall(
      acrossRequest({ sellTokenAddress: USDC.address, account: OWNER }),
      feesQuote(),
    )
    const sign = (): Promise<BridgeHook> =>
      provider.getSignedHook(SupportedChainId.MAINNET, call, NONCE, deadline, 290_000)
    const thenFail = (error: unknown) => (): Promise<never> => sign().then(() => Promise.reject(error))
    // The order then failed to send, or its answer was lost: kept (the SDK already uploaded it with the appData).
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, thenFail(new Error('Failed to fetch')))).rejects.toThrow(
      'Failed to fetch',
    )
    expect(stored()).toEqual([hook])
    // Declined in the wallet: kept too, for the same reason.
    localStorage.clear()
    const declined = { code: 4001, message: 'User rejected the request.' }
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, thenFail(declined))).rejects.toBe(declined)
    expect(stored()).toEqual([hook])
    // A browser that cannot keep it: the signed hook never reaches the order.
    signCalls.mockClear()
    const setItem = Storage.prototype.setItem
    const writes = jest.spyOn(Storage.prototype, 'setItem')
    writes.mockImplementationOnce(function (this: Storage, key: string, value: string) {
      setItem.call(this, key, value) // the records read back before signing
    })
    writes.mockImplementationOnce(() => {
      throw new Error('QuotaExceededError')
    })
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('cannot keep track of your bridges')
    expect(signCalls).toHaveBeenCalledTimes(1)
    writes.mockRestore()
    // The wallet switched while placing: its signer signed for another shed. Refused, and recorded under no one.
    localStorage.clear()
    signCalls.mockImplementationOnce(async (request) => ({
      signedMulticall: { to: FACTORY, data: await signedHook(OWNER_KEY, request as never), value: 0n },
      cowShedAccount: `0x${'5d'.repeat(20)}`, // the order would pay into this shed
      gasLimit: 290_000n,
    }))
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('signed by the wallet placing')
    expect(stored()).toEqual([])
    // Between the SDK's two reads of the signer: this shed, but a signature by another wallet. Refused.
    signCalls.mockImplementationOnce(async (request) => ({
      signedMulticall: {
        to: FACTORY,
        data: await signedHook(new Wallet(`0x${'0b'.repeat(32)}`), request as never),
        value: 0n,
      },
      cowShedAccount: SHED,
      gasLimit: 290_000n,
    }))
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('signed by the wallet placing')
    expect(stored()).toEqual([])
    // A hook naming another user, whoever signed it, would run for another shed. Refused.
    signCalls.mockImplementationOnce(async (request) => ({
      signedMulticall: { to: FACTORY, data: await signedHook(OWNER_KEY, request as never, SHED), value: 0n },
      cowShedAccount: SHED,
      gasLimit: 290_000n,
    }))
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('signed by the wallet placing')
    // A contract wallet (a Safe) signs by EIP-1271: its own isValidSignature answer decides.
    const code = jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'getCode').mockResolvedValue('0x6080')
    const answers = jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'call')
    const magic = (word: string): string => `${word}${'0'.repeat(56)}`
    answers.mockImplementation(async ({ data }) =>
      String(data).startsWith('0x1626ba7e') ? magic('0x1626ba7e') : `0x${'0'.repeat(63)}1`,
    )
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).resolves.toMatchObject({ recipient: SHED })
    answers.mockImplementation(async ({ data }) =>
      String(data).startsWith('0x1626ba7e') ? magic('0xffffffff') : `0x${'0'.repeat(63)}1`,
    )
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('signed by the wallet placing')
    code.mockResolvedValue('0x')
    answers.mockResolvedValue(`0x${'0'.repeat(63)}1`)
    localStorage.clear()
    // Records it cannot read back are not taken for none.
    localStorage.setItem(`ophisBridgeHooks:v0:${OWNER.toLowerCase()}`, '{"not": "a list"}')
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, sign)).rejects.toThrow('cannot keep track of your bridges')
    // Each wallet's records are its own.
    expect(stored(`0x${'0c'.repeat(20)}`)).toEqual([])
  })

  it('refuses to place while another bridge of the wallet still pays into its shed', async () => {
    const { provider, signCalls } = guardedProvider()
    const deadline = QUOTE_TIME + 1_800n

    // Settled together, the first hook would carry both outputs to its own recipient.
    openOrders.mockResolvedValueOnce([{ status: OrderStatus.OPEN, receiver: SHED }])
    await expect(signHook(provider, deadline)).rejects.toThrow('Another bridge from this wallet is still open')
    openOrders.mockRejectedValueOnce(new Error('503'))
    await expect(signHook(provider, deadline)).rejects.toThrow("Could not check this wallet's open orders")
    // With no orderbook wired, refused rather than unchecked.
    await expect(signHook(guardedProvider(null).provider, deadline)).rejects.toThrow('Could not check')
    expect(signCalls).not.toHaveBeenCalled()
    // An open order paying elsewhere, or orders into the shed that can no longer fill, do not block it.
    const closed = [OrderStatus.FULFILLED, OrderStatus.EXPIRED, OrderStatus.CANCELLED, OrderStatus.PRESIGNATURE_PENDING]
    openOrders.mockResolvedValueOnce([
      { status: OrderStatus.OPEN, receiver: OWNER },
      ...closed.map((status) => ({ status, receiver: SHED, validTo: Number(QUOTE_TIME) })),
    ])
    await expect(signHook(provider, deadline)).resolves.toMatchObject({ recipient: SHED })
    expect(openOrders).toHaveBeenLastCalledWith(SupportedChainId.MAINNET, OWNER)
  })
})

describe('OphisAcrossBridgeProvider: placement lock and hook gas', () => {
  afterEach(() => jest.restoreAllMocks())

  it('adds the guard call gas to the hook gas estimate', async () => {
    jest
      .spyOn(AcrossBridgeProvider.prototype, 'getGasLimitEstimationForHook')
      .mockResolvedValueOnce(240_000) // the shed exists
      .mockResolvedValueOnce(600_000) // the hook creates the shed
    const provider = new OphisAcrossBridgeProvider()

    expect(await provider.getGasLimitEstimationForHook(acrossRequest())).toBe(290_000)
    expect(await provider.getGasLimitEstimationForHook(acrossRequest())).toBe(650_000)
  })

  it('places other quotes straight through, and one Across bridge per wallet at a time in this browser', async () => {
    const place = jest.fn(async () => 'placed')
    // A swap, or another provider's bridge: nothing to hold.
    const near = { providerInfo: { dappId: 'cow-sdk://bridging/providers/near-intents' } } as BridgeQuoteResults
    for (const other of [null, near]) expect(await placeConfirmed(other, OWNER, place)).toBe('placed')
    // No Web Locks in this browser: an Across bridge is refused rather than placed unguarded.
    await expect(placeConfirmed(confirmedQuote(PCT), OWNER, place)).rejects.toThrow('cannot place a bridge safely')
    // Another tab holds the wallet's bridge lock: refused before anything is signed.
    const request = jest.fn((_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) =>
      callback(null),
    )
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    try {
      place.mockClear()
      await expect(placeConfirmed(confirmedQuote(PCT), OWNER, place)).rejects.toThrow('being placed in another tab')
      expect(place).not.toHaveBeenCalled()
      expect(request.mock.calls[0]?.[0]).toBe(`ophisBridge:v0:${OWNER.toLowerCase()}`)
      request.mockImplementation((_name, _options, callback) => callback({}))
      expect(await placeConfirmed(confirmedQuote(PCT), OWNER, place)).toBe('placed')
    } finally {
      Reflect.deleteProperty(navigator, 'locks')
    }
  })
})

describe('OphisAcrossBridgeProvider: bridge status', () => {
  afterEach(() => jest.restoreAllMocks())

  it("reports the order's own deposit: the one that pulled its input out of the order's shed", async () => {
    const provider = new OphisAcrossBridgeProvider()
    const LOGS = new Interface([
      'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
      'event Transfer(address indexed from, address indexed to, uint256 value)',
      'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
    ])
    const [SETTLEMENT, SPOKE, OTHER_SHED] = [`0x${'5c'.repeat(20)}`, `0x${'5b'.repeat(20)}`, `0x${'5d'.repeat(20)}`]
    const [A, B, SWAP] = [`0x${'aa'.repeat(56)}`, `0x${'bb'.repeat(56)}`, `0x${'cc'.repeat(56)}`]
    const word = (address: string): string => `0x${address.slice(2).padStart(64, '0')}`
    const log = (address: string, name: string, args: unknown[]): unknown => ({
      address,
      ...LOGS.encodeEventLog(LOGS.getEvent(name), args),
    })
    const trade = (uid: string, from = SETTLEMENT): unknown =>
      log(from, 'Trade', [OWNER, USDC.address, USDC.address, 1, 1, 0, uid])
    const paid = (to: string, value: number): unknown => log(USDC.address, 'Transfer', [SETTLEMENT, to, value])
    const pulled = (from: string, value: number, token = USDC.address): unknown =>
      log(token, 'Transfer', [from, SPOKE, value])
    const deposit = (
      depositor: string,
      id: number,
      input: number,
      token = USDC.address,
      chain = 42161,
      out = USDC.address,
    ): unknown =>
      log(SPOKE, 'FundsDeposited', [
        word(token),
        word(out),
        input,
        input,
        chain,
        id,
        1,
        2,
        0,
        word(depositor),
        word(OWNER),
        word('0x00'),
        '0x',
      ])
    const receipt = jest.spyOn(getRpcProvider(SupportedChainId.MAINNET), 'getTransactionReceipt')
    const status = jest.spyOn(provider, 'getStatus').mockResolvedValue({ status: 'executed' } as never)
    // The order's appData: bridge to USDC on Arbitrum.
    const bridging = { destinationChainId: '42161', destinationTokenAddress: USDC.address }
    const order = {
      uid: A,
      receiver: SHED,
      buyToken: USDC.address,
      fullAppData: JSON.stringify({ metadata: { bridging } }),
    }
    const ask = (logs: unknown[]): ReturnType<OphisAcrossBridgeProvider['getBridgingParams']> => {
      receipt.mockResolvedValueOnce({ status: 1, logs } as never)
      // The app names its settlement per chain (useCrossChainOrder), as for upstream.
      return provider.getBridgingParams(SupportedChainId.MAINNET, order as never, `0x${'ee'.repeat(32)}`, {
        [SupportedChainId.MAINNET]: SETTLEMENT as `0x${string}`,
      })
    }

    // Trades [an ordinary swap, bridge A, bridge B], deposits [A, B]: upstream pairs A with B's deposit.
    const batch = [trade(SWAP), trade(A), trade(B), paid(SHED, 1000), paid(OTHER_SHED, 1000)]
    const hooks = [pulled(SHED, 1000), deposit(SHED, 7, 1000), pulled(OTHER_SHED, 1000), deposit(OTHER_SHED, 8, 1000)]
    // Deposits anyone can add that name A's shed: another amount, another input token, or the same amount paid by them.
    const decoys = [
      deposit(SHED, 9, 5),
      deposit(SHED, 10, 1000, `0x${'e7'.repeat(20)}`),
      pulled(OTHER_SHED, 1000),
      deposit(SHED, 11, 1000),
      pulled(SHED, 0), // a zero transfer out of the shed needs no allowance
      deposit(SHED, 12, 0),
    ]
    // Right after A's own deposit: one with no pull of its own (WETH paid in native ETH logs none).
    const unpaid = [pulled(SHED, 1000), deposit(SHED, 7, 1000), deposit(SHED, 13, 1000)]
    // A token logging another transfer between the pull and the deposit (a fee), and a deposit to another token.
    const fee = log(USDC.address, 'Transfer', [SHED, OWNER, 1])
    const feeAndOtherOut = [
      pulled(SHED, 1000),
      fee,
      deposit(SHED, 7, 1000),
      deposit(SHED, 14, 1000, USDC.address, 42161, OWNER),
    ]
    for (const logs of [
      [...batch, ...unpaid],
      [...batch, ...feeAndOtherOut],
    ]) {
      expect(await ask(logs)).toMatchObject({ params: { bridgingId: '7' } })
    }
    expect(await ask([...batch, ...hooks, ...decoys])).toMatchObject({
      params: { bridgingId: '7', owner: SHED, inputAmount: 1000n },
    })
    expect(status).toHaveBeenCalledWith('7', SupportedChainId.MAINNET)
    // A's hook did not run: a deposit naming A's shed, with its tokens pulled from elsewhere, or sent elsewhere.
    expect(await ask([...batch, pulled(OTHER_SHED, 5), deposit(SHED, 9, 5)])).toBeNull()
    expect(await ask([...batch, pulled(SHED, 1000), deposit(SHED, 9, 5)])).toBeNull()
    // Paid out of A's shed, but not A's bridge: another token in or out, or a depositor Across would refund instead.
    const OTHER_TOKEN = `0x${'e7'.repeat(20)}`
    expect(await ask([...batch, pulled(SHED, 1000, OTHER_TOKEN), deposit(SHED, 15, 1000, OTHER_TOKEN)])).toBeNull()
    expect(
      await ask([...batch, pulled(SHED, 1000), deposit(SHED, 16, 1000, USDC.address, 42161, OTHER_TOKEN)]),
    ).toBeNull()
    expect(await ask([...batch, pulled(SHED, 1000), deposit(OWNER, 17, 1000)])).toBeNull()
    expect(await ask([...batch, log(USDC.address, 'Transfer', [SHED, OWNER, 1000]), deposit(SHED, 7, 1000)])).toBeNull()
    // An order whose appData records no bridge (refused before the receipt is read).
    receipt.mockResolvedValueOnce({ status: 1, logs: [...batch, ...hooks] } as never)
    expect(
      await provider.getBridgingParams(
        SupportedChainId.MAINNET,
        { ...order, fullAppData: '{}' } as never,
        `0x${'ee'.repeat(32)}`,
      ),
    ).toBeNull()
    receipt.mockReset()
    // Another signed hook of the wallet someone ran before the settlement paid A's shed (in a pre-hook), or after
    // A's own: A's deposit is the first one after the payout.
    const early = [pulled(SHED, 10), deposit(SHED, 20, 10)]
    const late = [pulled(SHED, 10), deposit(SHED, 21, 10)]
    for (const logs of [
      [...early, ...batch, ...hooks],
      [...batch, ...hooks, ...late],
    ]) {
      expect(await ask(logs)).toMatchObject({ params: { bridgingId: '7' } })
    }
    // A signed hook that bridged the shed elsewhere, then a deposit with no pull of its own (WETH paid in native ETH
    // logs none) for A's bridge: it cannot borrow that hook's pull.
    expect(
      await ask([...batch, pulled(SHED, 1000), deposit(SHED, 30, 1000, USDC.address, 10), deposit(SHED, 31, 1000)]),
    ).toBeNull()
    // The payout is the settlement's non-zero transfer into the shed after A's Trade: not a zero one (no allowance
    // needed), nor one before the Trade (a pre-interaction), nor a third party's, nor a Trade from another contract.
    for (const logs of [
      [trade(A), paid(SHED, 0), ...early, paid(SHED, 1000), ...hooks],
      [paid(SHED, 5), ...early, trade(A), paid(SHED, 1000), ...hooks],
      [trade(A), log(USDC.address, 'Transfer', [OWNER, SHED, 10]), ...early, paid(SHED, 1000), ...hooks],
      [trade(A, SPOKE), log(USDC.address, 'Transfer', [SPOKE, SHED, 10]), ...early, ...batch, ...hooks],
    ]) {
      expect(await ask(logs)).toMatchObject({ params: { bridgingId: '7' } })
    }
    // The shed's only deposit goes to another chain (another order's bridge carried A's output): not A's bridge.
    expect(await ask([...batch, pulled(SHED, 2000), deposit(SHED, 12, 2000, USDC.address, 8453)])).toBeNull()
    // No Trade for A, or one from a contract that did not pay A's shed: not A's settlement.
    expect(await ask([trade(B), paid(SHED, 1000), ...hooks])).toBeNull()
    expect(await ask([trade(A, SPOKE), paid(SHED, 1000), ...hooks])).toBeNull()
  })
})

// Split from the Across block above to keep each top-level describe under the
// max-lines-per-function cap.
describe('ophisBridgeProviders: chains, decode-only provider, invariants', () => {
  describe('DecodeOnlyBungeeBridgeProvider (shared with the explorer, decode-only)', () => {
    const provider = (): DecodeOnlyBungeeBridgeProvider => createDecodeOnlyBungeeBridgeProvider()

    afterEach(() => jest.restoreAllMocks())

    it('keeps the upstream dappId so existing Bungee orders still resolve', () => {
      expect(provider().info.dappId).toBe(new BungeeBridgeProvider({ apiOptions: {} }).info.dappId)
    })

    it('advertises no networks, so the quote fan-out and the destination picker never select it', async () => {
      expect(await provider().getNetworks()).toEqual([])
    })

    it('reports no buy tokens without calling the (dead) API', async () => {
      const upstreamSpy = jest.spyOn(BungeeBridgeProvider.prototype, 'getBuyTokens')
      const fetchSpy = jest.spyOn(global, 'fetch')

      const result = await provider().getBuyTokens({
        buyChainId: SupportedChainId.BASE,
        sellChainId: SupportedChainId.MAINNET,
      })

      expect(result).toEqual({ tokens: [], isRouteAvailable: false })
      expect(upstreamSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
    })
  })

  describe('custom chain infos', () => {
    // NOTE: sdk-config's isEvmChainInfo() is enum-membership (chainId in
    // EvmChains), so it can never accept 130/4663 — assert the EvmChainInfo
    // SHAPE structurally instead. The single isEvmChain() call inside
    // sdk-bridging 4.0.2 sits in the NEAR provider, which is not extended.
    it.each([
      [UNICHAIN_BRIDGE_CHAIN, 130, 'Unichain'],
      [ROBINHOOD_BRIDGE_CHAIN, 4663, 'Robinhood Chain'],
    ])('%#: is a complete EvmChainInfo', (chain, id, label) => {
      expect(chain.id).toBe(id)
      expect(chain.label).toBe(label)
      expect(chain.eip155Label).toBeTruthy()
      expect(chain.addressPrefix).toBeTruthy()
      expect(chain.nativeCurrency.symbol).toBe('ETH')
      expect(chain.nativeCurrency.chainId).toBe(id)
      expect(chain.logo.light).toBeTruthy()
      expect(chain.contracts.multicall3?.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(chain.rpcUrls.default.http[0]).toMatch(/^https:/)
    })
  })

  describe('BRIDGE_SOURCE_CHAIN_IDS invariant', () => {
    // Mutation guard: the source set must equal the union of the UPSTREAM
    // (unextended) lists of the providers that can still quote (Across + NEAR
    // Intents; Bungee is decode-only since 2026-09-10 and its seven chains are
    // all in NEAR's list) PLUS the chains we deliberately made executable via our own
    // on-chain deploys (EXTRA_ACROSS_SOURCE_CHAIN_IDS, gated OFF until the math
    // helper is live). If an SDK upgrade widens upstream support, or someone
    // edits either set without provider-side backing, this fails and forces a
    // conscious review — source chains additionally need CoW Shed / math-helper
    // deployments plus an E2E hook-execution proof.
    it('equals the union of upstream provider EVM source networks plus our executable additions', async () => {
      const upstream = [
        ...(await new AcrossBridgeProvider().getNetworks()),
        ...(await new NearIntentsBridgeProvider({}).getNetworks()),
      ]
      const expected = new Set([
        ...upstream.filter((c) => isEvmChainInfo(c)).map((c) => c.id),
        4663, // NEAR hood uses a deposit-address receiver, independently of Across.
        ...EXTRA_ACROSS_SOURCE_CHAIN_IDS,
      ])

      expect(new Set(BRIDGE_SOURCE_CHAIN_IDS)).toEqual(expected)
    })

    it('keeps every flagged source OFF by default (flags unset in the build)', () => {
      expect(ACROSS_INK_LINEA_SOURCE_ENABLED).toBe(false)
      expect(ACROSS_ROBINHOOD_SOURCE_ENABLED).toBe(false)
      expect(ACROSS_POLYGON_SOURCE_ENABLED).toBe(false)
      expect(ACROSS_OPTIMISM_SOURCE_ENABLED).toBe(false)
      expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(137)).toBe(false)
      expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(10)).toBe(false)
      expect(EXTRA_ACROSS_SOURCE_CHAIN_IDS).toEqual([])
      // The executable set and the source set derive from the same const, so
      // they agree on every flagged chain in every flag state.
      for (const id of [57073, 59144]) {
        expect(BRIDGE_SOURCE_CHAIN_IDS.has(id)).toBe(false)
        expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(id)).toBe(false)
      }
      expect(BRIDGE_SOURCE_CHAIN_IDS.has(4663)).toBe(true)
      expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(4663)).toBe(false)
    })

    it('enables Polygon and Optimism independently after source preflight', () => {
      expect(acrossPolygonOptimismSourceIds(false, false)).toEqual([])
      expect(acrossPolygonOptimismSourceIds(true, false)).toEqual([137])
      expect(acrossPolygonOptimismSourceIds(false, true)).toEqual([10])
      expect(acrossPolygonOptimismSourceIds(true, true)).toEqual([137, 10])
    })

    it('adds exactly Robinhood Chain (4663) when its own gate is enabled', () => {
      expect(acrossRobinhoodSourceIds(true)).toEqual([4663])
      expect(acrossRobinhoodSourceIds(false)).toEqual([])
    })

    it('keeps the two source flags independent (per-chain readiness)', () => {
      // Robinhood must be enablable WITHOUT enabling Ink/Linea and vice versa: a
      // combined flag would force turning on a chain that is not ready in order
      // to turn on one that is (the reason #1194's shared flag was split).
      expect([...acrossInkLineaSourceIds(true)]).not.toContain(4663)
      expect([...acrossRobinhoodSourceIds(true)]).not.toContain(57073)
      expect([...acrossRobinhoodSourceIds(true)]).not.toContain(59144)
    })

    it('adds exactly Ink (57073) and Linea (59144) when the flag gate is enabled', () => {
      // Both source sets spread EXTRA_ACROSS_SOURCE_CHAIN_IDS, which is
      // acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED). Proving the gate
      // for enabled=true proves what flipping the flag would add to both sets,
      // deterministically and without re-evaluating the module under a mutated env.
      expect([...acrossInkLineaSourceIds(true)].sort((a, b) => a - b)).toEqual([57073, 59144])
      expect(acrossInkLineaSourceIds(false)).toEqual([])
    })

    it('EXTRA_ACROSS_SOURCE_CHAIN_IDS is exactly the concat of the per-chain gates', () => {
      expect(EXTRA_ACROSS_SOURCE_CHAIN_IDS).toEqual([
        ...acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED),
        ...acrossRobinhoodSourceIds(ACROSS_ROBINHOOD_SOURCE_ENABLED),
        ...acrossPolygonOptimismSourceIds(ACROSS_POLYGON_SOURCE_ENABLED, ACROSS_OPTIMISM_SOURCE_ENABLED),
      ])
    })
  })

  it('registers Polygon and Optimism math helpers in both shipped SDK builds', () => {
    const patch = readFileSync(join(__dirname, '../../../../patches/@cowprotocol__sdk-bridging@4.0.2.patch'), 'utf8')
    const helper = '"0xEdE97D044d4C8aAA682968bee10284521B9f311a"'
    for (const chain of ['POLYGON', 'OPTIMISM']) {
      const entries = patch.split('\n').filter((line) => line.startsWith('+') && line.includes(`.${chain}]: ${helper}`))
      expect(entries).toHaveLength(2)
    }
  })

  describe('Robinhood 4663 source prerequisites (sovereign)', () => {
    // 4663 is not a SupportedChainId member, so the SDK resolves it only through
    // our sdk-bridging patch. If either registry entry goes missing,
    // getUnsignedBridgeCall throws "Spoke pool/Math contract address not found"
    // at signing time — after the user has already been shown a quote.
    it('registers the SpokePool and math helper for 4663 in the sdk-bridging patch', () => {
      const patch = readFileSync(join(__dirname, '../../../../patches/@cowprotocol__sdk-bridging@4.0.2.patch'), 'utf8')
      expect(patch).toContain('4663: "0xD29C85F15DF544bA632C9E25829fd29d767d7978"')
      expect(patch).toContain('4663: "0xEdE97D044d4C8aAA682968bee10284521B9f311a"')
      // Post-trade bridge tracking is gated on isSupportedChain(), which is
      // permanently false for 4663; without this widening EVERY Robinhood bridge
      // order throws BridgeOrderParsingError once its trade settles.
      expect(patch).toContain('!ACROSS_SPOOK_CONTRACT_ADDRESSES[chainId]')
    })

    it('carries the explicit inputToken/outputToken fee-quote hunk in BOTH dist builds', () => {
      // jest resolves the package through `main` (dist/index.js) while Vite ships
      // `module` (dist/index.mjs), so the behavioural getQuote test above only
      // proves the CJS build. Each hunk must appear exactly twice: once per build.
      const patch = readFileSync(join(__dirname, '../../../../patches/@cowprotocol__sdk-bridging@4.0.2.patch'), 'utf8')
      expect(patch.match(/^\+\s+inputToken: sellTokenAddress,$/gm)).toHaveLength(2)
      expect(patch.match(/^\+\s+outputToken: buyTokenAddress,$/gm)).toHaveLength(2)
      expect(
        patch.match(/^\+\s+\? \{ inputToken: request\.inputToken, outputToken: request\.outputToken \}$/gm),
      ).toHaveLength(2)
    })
  })
})

describe('Across API key + integrator ID (sdk-bridging patch)', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  function mockFetch(): jest.Mock {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => [] })
    global.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  const apiOf = (provider: AcrossBridgeProvider): { getAvailableRoutes(params: object): Promise<unknown> } =>
    (provider as unknown as { api: { getAvailableRoutes(params: object): Promise<unknown> } }).api

  it('sends the integratorId param and the Bearer header when configured', async () => {
    const fetchMock = mockFetch()
    await apiOf(
      new OphisAcrossBridgeProvider({ apiOptions: { apiKey: 'test-key', integratorId: '0x0311' } }),
    ).getAvailableRoutes({ originChainId: 1 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).searchParams.get('integratorId')).toBe('0x0311')
    expect(new URL(url).searchParams.get('originChainId')).toBe('1')
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' })
  })

  it('stays keyless and untagged when neither is configured', async () => {
    const fetchMock = mockFetch()
    await apiOf(new OphisAcrossBridgeProvider()).getAvailableRoutes({})

    const [url, init] = fetchMock.mock.calls[0]
    expect(new URL(url).searchParams.has('integratorId')).toBe(false)
    expect(init.headers).toBeUndefined()
  })

  it('ophisAcrossApiOptions carries the Ophis integrator ID and never a blank key', () => {
    const options = ophisAcrossApiOptions()
    expect(options.integratorId).toBe('0x0311')
    expect(options.apiKey).not.toBe('')
  })

  // The signed hook's own tagging is covered with the guard (guarded hook block above).
  it('pads any calldata length so the tag is the last bytes of a whole word', () => {
    for (const bytes of [4 + 32 * 3, 0, 1, 27, 32, 100]) {
      const input = `0x${'cd'.repeat(bytes)}`
      const tagged = tagAcrossIntegratorCalldata(input)
      expect(tagged.startsWith(input)).toBe(true)
      expect(tagged.endsWith('1dc0de0311')).toBe(true)
      expect(((tagged.length - 2) / 2) % 32).toBe(0)
      // Never more than one word of padding + tag on top of the input.
      expect((tagged.length - input.length) / 2).toBeLessThanOrEqual(32)
    }
  })
})
