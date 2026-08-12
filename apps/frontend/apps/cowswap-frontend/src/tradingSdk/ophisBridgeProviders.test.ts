import {
  ACROSS_INK_LINEA_SOURCE_ENABLED,
  acrossInkLineaSourceIds,
  BRIDGE_SOURCE_CHAIN_IDS,
  EXTRA_ACROSS_SOURCE_CHAIN_IDS,
} from '@cowprotocol/common-const'
import { isEvmChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, BungeeBridgeProvider, NearIntentsBridgeProvider } from '@cowprotocol/sdk-bridging'

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
        const upstreamSpy = jest
          .spyOn(AcrossBridgeProvider.prototype, 'getBuyTokens')
          .mockResolvedValue(upstreamResult)

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
        const upstreamSpy = jest
          .spyOn(AcrossBridgeProvider.prototype, 'getBuyTokens')
          .mockResolvedValue(upstreamResult)

        const result = await new OphisAcrossBridgeProvider().getBuyTokens({
          buyChainId: 4663,
          sellChainId: SupportedChainId.MAINNET,
        })

        expect(result).toBe(upstreamResult)
        expect(upstreamSpy).toHaveBeenCalledTimes(1)
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

    it('keeps Ink and Linea OFF by default (flag unset in the build)', () => {
      expect(ACROSS_INK_LINEA_SOURCE_ENABLED).toBe(false)
      expect(EXTRA_ACROSS_SOURCE_CHAIN_IDS).toEqual([])
      expect(BRIDGE_SOURCE_CHAIN_IDS.has(57073)).toBe(false)
      expect(BRIDGE_SOURCE_CHAIN_IDS.has(59144)).toBe(false)
      // The executable set and the source set derive from the same const, so
      // they agree on Ink/Linea in every flag state.
      expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(57073)).toBe(false)
      expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(59144)).toBe(false)
    })

    it('adds exactly Ink (57073) and Linea (59144) when the flag gate is enabled', () => {
      // Both source sets spread EXTRA_ACROSS_SOURCE_CHAIN_IDS, which is
      // acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED). Proving the gate
      // for enabled=true proves what flipping the flag would add to both sets,
      // deterministically and without re-evaluating the module under a mutated env.
      expect([...acrossInkLineaSourceIds(true)].sort((a, b) => a - b)).toEqual([57073, 59144])
      expect(acrossInkLineaSourceIds(false)).toEqual([])
      expect(EXTRA_ACROSS_SOURCE_CHAIN_IDS).toEqual(acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED))
    })
  })
})
