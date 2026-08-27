import {
  ACROSS_INK_LINEA_SOURCE_ENABLED,
  ACROSS_ROBINHOOD_SOURCE_ENABLED,
  acrossInkLineaSourceIds,
  acrossRobinhoodSourceIds,
  BRIDGE_SOURCE_CHAIN_IDS,
  EXTRA_ACROSS_SOURCE_CHAIN_IDS,
} from '@cowprotocol/common-const'
import { isEvmChainInfo, OrderKind, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'
import {
  AcrossApi,
  AcrossBridgeProvider,
  BungeeBridgeProvider,
  NearIntentsBridgeProvider,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'

import { readFileSync } from 'fs'
import { join } from 'path'

import { ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'
import {
  ACROSS_EXECUTABLE_SOURCE_IDS,
  OphisAcrossBridgeProvider,
  OphisBungeeBridgeProvider,
} from './ophisBridgeProviders'

const ids = (chains: { id: number }[]): number[] => chains.map((c) => c.id)

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
          buyChainId: 4663,
          sellChainId: SupportedChainId.GNOSIS_CHAIN,
        })

        expect(result).toEqual({ tokens: [], isRouteAvailable: false })
        expect(upstreamSpy).not.toHaveBeenCalled()
      })

      it('delegates to the upstream implementation for executable sources', async () => {
        const upstreamSpy = jest.spyOn(AcrossBridgeProvider.prototype, 'getBuyTokens').mockResolvedValue(upstreamResult)

        const result = await new OphisAcrossBridgeProvider().getBuyTokens({
          buyChainId: 4663,
          sellChainId: SupportedChainId.MAINNET,
        })

        expect(result).toBe(upstreamResult)
        expect(upstreamSpy).toHaveBeenCalledTimes(1)
      })
    })

    // Typed seam onto the protected AcrossApi so the route fallback's
    // getSupportedTokens() call can be stubbed without an `as any`.
    class TestableAcrossProvider extends OphisAcrossBridgeProvider {
      get testApi(): AcrossApi {
        return this.api
      }
    }

    describe('getIntermediateTokens route-based fallback', () => {
      // Typed fixtures so the test tracks the SDK contract the override depends on.
      const USDG_4663 = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
      const acrossRequest = (overrides: Partial<QuoteBridgeRequest> = {}): QuoteBridgeRequest =>
        ({
          kind: OrderKind.SELL,
          sellTokenChainId: SupportedChainId.MAINNET,
          buyTokenChainId: 4663,
          buyTokenAddress: USDG_4663,
          amount: 1_000_000n,
          ...overrides,
        }) as unknown as QuoteBridgeRequest

      const USDC: TokenInfo = { chainId: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 }
      const USDG_MAINNET: TokenInfo = { chainId: 1, address: '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', symbol: 'USDG-MAINNET', decimals: 6 }
      const BASE_USDC: TokenInfo = { chainId: 8453, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }

      const mockRoutes = (routes: unknown): jest.SpyInstance =>
        jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => routes } as Response)

      afterEach(() => jest.restoreAllMocks())

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

      it('returns the symbol match untouched when it is non-empty (no route fetch)', async () => {
        const symbolMatch: TokenInfo[] = [{ chainId: 1, address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 }]
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue(symbolMatch)
        const fetchSpy = jest.spyOn(global, 'fetch')

        const result = await new OphisAcrossBridgeProvider().getIntermediateTokens(acrossRequest())

        expect(result).toBe(symbolMatch)
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('falls back to Across available-routes when the symbol match is empty (the USDG corridor)', async () => {
        jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
        mockRoutes([
          { originToken: USDC.address }, // cross-asset USDC -> USDG
          { originToken: USDG_MAINNET.address }, // chain-aliased USDG-MAINNET -> USDG
        ])
        const provider = new TestableAcrossProvider()
        jest.spyOn(provider.testApi, 'getSupportedTokens').mockResolvedValue([USDC, USDG_MAINNET, BASE_USDC])

        const result = await provider.getIntermediateTokens(acrossRequest())

        // Both mainnet route origins returned; the Base USDC (wrong chain) excluded.
        expect(result).toEqual([USDC, USDG_MAINNET])
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
  })

  describe('OphisBungeeBridgeProvider', () => {
    it('extends the upstream network list with Ink, Linea and Unichain', async () => {
      const provider = new OphisBungeeBridgeProvider({ apiOptions: {} })
      const base = await new BungeeBridgeProvider({ apiOptions: {} }).getNetworks()
      const extended = await provider.getNetworks()

      expect(ids(extended)).toEqual(expect.arrayContaining(ids(base)))
      expect(ids(extended)).toEqual(expect.arrayContaining([57073, 59144, 130]))
      // Plasma + Robinhood Chain serve zero routes on the Bungee manual
      // pipeline (empty bridges arrays, verified live 2026-08-10)
      expect(ids(extended)).not.toContain(9745)
      expect(ids(extended)).not.toContain(4663)
    })

    it('has no duplicate chain ids', async () => {
      const extended = ids(await new OphisBungeeBridgeProvider({ apiOptions: {} }).getNetworks())
      expect(new Set(extended).size).toBe(extended.length)
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
    // (unextended) provider lists PLUS the chains we deliberately made
    // executable via our own on-chain deploys (EXTRA_ACROSS_SOURCE_CHAIN_IDS,
    // gated OFF until the math helper is live). If an SDK upgrade widens upstream
    // support, or someone edits either set without provider-side backing, this
    // fails and forces a conscious review — source chains additionally need CoW
    // Shed / math-helper deployments plus an E2E hook-execution proof.
    it('equals the union of upstream provider EVM source networks plus our executable additions', async () => {
      const upstream = [
        ...(await new AcrossBridgeProvider().getNetworks()),
        ...(await new BungeeBridgeProvider({ apiOptions: {} }).getNetworks()),
        ...(await new NearIntentsBridgeProvider({}).getNetworks()),
      ]
      const expected = new Set([
        ...upstream.filter((c) => isEvmChainInfo(c)).map((c) => c.id),
        ...EXTRA_ACROSS_SOURCE_CHAIN_IDS,
      ])

      expect(new Set(BRIDGE_SOURCE_CHAIN_IDS)).toEqual(expected)
    })

    it('keeps every flagged source OFF by default (flags unset in the build)', () => {
      expect(ACROSS_INK_LINEA_SOURCE_ENABLED).toBe(false)
      expect(ACROSS_ROBINHOOD_SOURCE_ENABLED).toBe(false)
      expect(EXTRA_ACROSS_SOURCE_CHAIN_IDS).toEqual([])
      // The executable set and the source set derive from the same const, so
      // they agree on every flagged chain in every flag state.
      for (const id of [57073, 59144, 4663]) {
        expect(BRIDGE_SOURCE_CHAIN_IDS.has(id)).toBe(false)
        expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(id)).toBe(false)
      }
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
      ])
    })
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
  })
})
