import {
  BRIDGE_ONLY_DESTINATION_LABELS,
  CHAIN_INFO,
  getChainInfo,
  HYPERCORE_CHAIN_ID,
  isBridgeOnlyDestinationChain,
  MONAD_CHAIN_ID,
  NATIVE_CURRENCIES,
  NATIVE_CURRENCY_ADDRESS,
  SORTED_DST_CHAIN_IDS,
  TokenWithLogo,
  SUI_CHAIN_ID,
  SUI_NATIVE_CURRENCY_ADDRESS,
  toBridgeChainInfo,
  TRON_CHAIN_ID,
  TRX_NATIVE_CURRENCY_ADDRESS,
  XLAYER_CHAIN_ID,
} from '@cowprotocol/common-const'
import {
  ExplorerDataType,
  getBlockExplorerUrl,
  getExplorerLink,
  getIsNativeToken,
  getWrappedToken,
  isSuiAddress,
  isSuiCoinType,
  isTronAddress,
  shortenAddress,
} from '@cowprotocol/common-utils'
import { isEvmChain, OrderKind, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'
import type { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { getTokenPolicyDecision, TokenPolicyProfile } from '@cowprotocol/tokens'

// eslint-disable-next-line import/no-internal-modules -- pure util under test, not part of the module's index
import { filterDestinationChains } from 'modules/tokensList/utils/chainsState'
// eslint-disable-next-line import/no-internal-modules -- pure util under test, not part of the module's index
import * as recentTokensStorage from 'modules/tokensList/utils/recentTokensStorage'

import { isNonEvmRecipientChain, isRecipientAddress } from 'common/utils/recipientAddress.utils'

import {
  acrossBridgeProvider,
  bridgingSdk,
  bungeeBridgeProvider,
  nearIntentsBridgeProvider,
  setQuoteBridgeProviders,
} from './bridgingSdk'

const availableIds = (): string[] => bridgingSdk.getAvailableProviders().map((p) => p.info.dappId)

describe('bridgingSdk provider registry', () => {
  afterEach(() => {
    setQuoteBridgeProviders([acrossBridgeProvider.info.dappId, nearIntentsBridgeProvider.info.dappId])
  })

  it('advertises both quote providers plus the decode-only Bungee entry from boot', () => {
    expect(availableIds()).toEqual(
      expect.arrayContaining([
        acrossBridgeProvider.info.dappId,
        nearIntentsBridgeProvider.info.dappId,
        bungeeBridgeProvider.info.dappId,
      ]),
    )
  })

  it('keeps the decode-only Bungee entry when the quote set is narrowed (smart-contract wallets, flags)', () => {
    // BridgeProvidersUpdater narrows the quote set to NEAR only for smart-contract
    // wallets; getProviderFromAppData/getOrder search this same available list,
    // so historical Bungee orders must stay resolvable regardless.
    setQuoteBridgeProviders([nearIntentsBridgeProvider.info.dappId])

    expect(availableIds()).toEqual(
      expect.arrayContaining([nearIntentsBridgeProvider.info.dappId, bungeeBridgeProvider.info.dappId]),
    )
    expect(availableIds()).not.toContain(acrossBridgeProvider.info.dappId)
  })

  it('keeps the decode-only Bungee entry even with no quote provider at all', () => {
    setQuoteBridgeProviders([])

    expect(availableIds()).toEqual([bungeeBridgeProvider.info.dappId])
  })

  it('never lists Bungee first while a quote provider is enabled (single-quote path takes providers[0] ungated)', () => {
    expect(availableIds()[0]).not.toBe(bungeeBridgeProvider.info.dappId)

    setQuoteBridgeProviders([nearIntentsBridgeProvider.info.dappId])
    expect(availableIds()[0]).toBe(nearIntentsBridgeProvider.info.dappId)
  })

  it('registers Bungee as the decode-only subclass: no networks, no buy tokens, no API call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')

    expect(await bungeeBridgeProvider.getNetworks()).toEqual([])
    expect(await bungeeBridgeProvider.getBuyTokens({ buyChainId: 8453, sellChainId: 1 })).toEqual({
      tokens: [],
      isRouteAvailable: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })
})

describe('NEAR Intents destinations Ophis adds (Monad, X Layer)', () => {
  const nearToken = (blockchain: string, symbol: string, decimals: number, contractAddress?: string): object => ({
    assetId: `test:${blockchain}:${symbol}`,
    blockchain,
    symbol,
    decimals,
    contractAddress,
    price: 0,
    priceUpdatedAt: '2026-09-11T00:00:00Z',
  })

  it('registers both chains on the NEAR provider network list with the app cosmetics', async () => {
    const byId = new Map((await nearIntentsBridgeProvider.getNetworks()).map((n) => [n.id, n]))

    expect(byId.get(MONAD_CHAIN_ID)?.label).toBe('Monad')
    expect(byId.get(MONAD_CHAIN_ID)?.nativeCurrency.symbol).toBe('MON')
    expect(byId.get(XLAYER_CHAIN_ID)?.label).toBe('X Layer')
    expect(byId.get(XLAYER_CHAIN_ID)?.nativeCurrency.symbol).toBe('OKB')
  })

  it('maps NEAR tokens on those chains (native + ERC-20) to buy tokens', async () => {
    const api = (nearIntentsBridgeProvider as unknown as { api: { getTokens(): Promise<object[]> } }).api
    const spy = jest
      .spyOn(api, 'getTokens')
      .mockResolvedValue([
        nearToken('monad', 'MON', 18),
        nearToken('monad', 'USDC', 6, '0x754704bc059f8c67012fed69bc8a327a5aafb603'),
        nearToken('xlayer', 'OKB', 18),
        nearToken('eth', 'USDC', 6, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
      ])

    const monad = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: MONAD_CHAIN_ID as TargetChainId })
    expect(monad.isRouteAvailable).toBe(true)
    expect(monad.tokens.map((t) => t.symbol).sort()).toEqual(['MON', 'USDC'])
    expect(monad.tokens.find((t) => t.symbol === 'MON')?.address.toLowerCase()).toBe(
      NATIVE_CURRENCY_ADDRESS.toLowerCase(),
    )

    const xlayer = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: XLAYER_CHAIN_ID as TargetChainId })
    expect(xlayer.tokens.map((t) => t.symbol)).toEqual(['OKB'])
    spy.mockRestore()
  })

  it('treats them as EVM chains for addresses, outside the trading chain map', () => {
    expect(isEvmChain(MONAD_CHAIN_ID)).toBe(true)
    expect(isEvmChain(XLAYER_CHAIN_ID)).toBe(true)
    // Not trading chains: the explorer derives its network routes from CHAIN_INFO.
    expect(CHAIN_INFO[MONAD_CHAIN_ID as TargetChainId]).toBeUndefined()
    expect(getChainInfo(MONAD_CHAIN_ID as TargetChainId).label).toBe('Monad')
    expect(isRecipientAddress('0x3F92Ac7B4f2ad492D7ADe1bdDf5003922F21331b', MONAD_CHAIN_ID)).toBe(true)
  })

  it('reaches the destination picker: ordered list, provider-network filter, native semantics (Codex on #1388)', () => {
    // The picker is fed by SORTED_DST_CHAIN_IDS and filterDestinationChains, not
    // by the provider registration alone.
    expect(SORTED_DST_CHAIN_IDS).toEqual(expect.arrayContaining([MONAD_CHAIN_ID, XLAYER_CHAIN_ID]))
    const kept = filterDestinationChains([toBridgeChainInfo(MONAD_CHAIN_ID), toBridgeChainInfo(XLAYER_CHAIN_ID)])
    expect(kept?.map((c) => c.id)).toEqual([MONAD_CHAIN_ID, XLAYER_CHAIN_ID])
    // Native MON / OKB at the sentinel address are native, not ERC-20s.
    expect(getIsNativeToken(MONAD_CHAIN_ID as SupportedChainId, NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(getIsNativeToken(XLAYER_CHAIN_ID as SupportedChainId, NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(getChainInfo(XLAYER_CHAIN_ID as TargetChainId).nativeCurrency.symbol).toBe('OKB')
  })

  it('carries wrapped twins, native explorer links and the shared destination predicate (Codex round 2)', () => {
    // getWrappedToken() maps a native output through WRAPPED_NATIVE_CURRENCIES
    // (USD value, price impact, approval preview).
    expect(getWrappedToken(NATIVE_CURRENCIES[MONAD_CHAIN_ID as TargetChainId]).symbol).toBe('WMON')
    expect(getWrappedToken(NATIVE_CURRENCIES[XLAYER_CHAIN_ID as TargetChainId]).symbol).toBe('WOKB')
    // No Ophis explorer route for these chains: link to their native explorer.
    const addr = '0x3F92Ac7B4f2ad492D7ADe1bdDf5003922F21331b'
    expect(getExplorerLink(MONAD_CHAIN_ID, addr, ExplorerDataType.ADDRESS)).toBe(
      `https://monadscan.com/address/${addr}`,
    )
    expect(getExplorerLink(XLAYER_CHAIN_ID, addr, ExplorerDataType.ADDRESS)).toBe(
      `https://www.oklink.com/xlayer/address/${addr}`,
    )
    // One predicate for the picker filter and the invalid-output updater.
    expect(isBridgeOnlyDestinationChain(MONAD_CHAIN_ID)).toBe(true)
    expect(isBridgeOnlyDestinationChain(XLAYER_CHAIN_ID)).toBe(true)
    expect(isBridgeOnlyDestinationChain(SupportedChainId.MAINNET)).toBe(false)
    expect(isBridgeOnlyDestinationChain(undefined)).toBe(false)
    // Public copy (About, Protocol) lists destinations from this same registry.
    expect(BRIDGE_ONLY_DESTINATION_LABELS).toEqual(['Monad', 'X Layer', 'Sui', 'Tron', 'Hyperliquid'])
  })

  it('passes the token policy for a valid destination asset on those chains (Codex round 4)', () => {
    const profile = TokenPolicyProfile.ESTABLISHED_SETTLEMENT
    // Selecting a Monad / X Layer token runs through getTokenPolicyDecision before onSelectToken.
    expect(
      getTokenPolicyDecision(
        { chainId: MONAD_CHAIN_ID, address: '0x754704bc059f8c67012fed69bc8a327a5aafb603' },
        profile,
      ),
    ).toEqual({ allowed: true, reason: 'approved' })
    expect(
      getTokenPolicyDecision({ chainId: XLAYER_CHAIN_ID, address: NATIVE_CURRENCY_ADDRESS }, profile).allowed,
    ).toBe(true)
    expect(getTokenPolicyDecision({ chainId: MONAD_CHAIN_ID, address: 'not-an-address' }, profile)).toEqual({
      allowed: false,
      reason: 'invalid-token',
    })
  })
})

describe('NEAR Intents non-EVM destinations Ophis adds (Sui, Tron, Hyperliquid)', () => {
  const SUI_ADDR = '0x0000000000000000000000000000000000000000000000000000000000000002'
  const SUI_USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
  const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const HL_USDC_HIP1 = '0x6d1e7cde53ba9467b783cb7c530ce054'
  const HL_USDC_ERC20 = '0xb88339CB7199b77E23DB6E890353E22632Ba630f'
  const EVM_ADDR = '0x3F92Ac7B4f2ad492D7ADe1bdDf5003922F21331b'
  const profile = TokenPolicyProfile.ESTABLISHED_SETTLEMENT
  const nearToken = (blockchain: string, symbol: string, decimals: number, contractAddress?: string): object => ({
    assetId: `test:${blockchain}:${symbol}`,
    blockchain,
    symbol,
    decimals,
    contractAddress,
    price: 0,
    priceUpdatedAt: '2026-09-11T00:00:00Z',
  })

  it('validates recipient addresses per chain, checksum included for Tron', () => {
    expect(isSuiAddress(SUI_ADDR)).toBe(true)
    expect(isSuiAddress(EVM_ADDR)).toBe(false)
    expect(isTronAddress(TRON_USDT)).toBe(true)
    expect(isTronAddress(TRX_NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(isTronAddress(TRON_USDT.slice(0, -1) + 'u')).toBe(false) // checksum broken
    expect(isSuiCoinType(SUI_USDC)).toBe(true)
    expect(isSuiCoinType(SUI_NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(isSuiCoinType(SUI_ADDR)).toBe(false)
    // The app's recipient seams route through the same rules.
    expect(isRecipientAddress(SUI_ADDR, SUI_CHAIN_ID)).toBe(true)
    expect(isRecipientAddress(EVM_ADDR, SUI_CHAIN_ID)).toBe(false)
    expect(isRecipientAddress(TRON_USDT, TRON_CHAIN_ID)).toBe(true)
    expect(isRecipientAddress(EVM_ADDR, HYPERCORE_CHAIN_ID)).toBe(true)
    expect(isRecipientAddress(SUI_ADDR, HYPERCORE_CHAIN_ID)).toBe(false)
  })

  it("token policy accepts each chain's own token id format and nothing else", () => {
    expect(getTokenPolicyDecision({ chainId: SUI_CHAIN_ID, address: SUI_USDC }, profile).allowed).toBe(true)
    expect(
      getTokenPolicyDecision({ chainId: SUI_CHAIN_ID, address: SUI_NATIVE_CURRENCY_ADDRESS }, profile).allowed,
    ).toBe(true)
    expect(getTokenPolicyDecision({ chainId: SUI_CHAIN_ID, address: EVM_ADDR }, profile).allowed).toBe(false)
    expect(getTokenPolicyDecision({ chainId: TRON_CHAIN_ID, address: TRON_USDT }, profile).allowed).toBe(true)
    expect(getTokenPolicyDecision({ chainId: TRON_CHAIN_ID, address: SUI_USDC }, profile).allowed).toBe(false)
    expect(getTokenPolicyDecision({ chainId: HYPERCORE_CHAIN_ID, address: HL_USDC_HIP1 }, profile).allowed).toBe(true)
  })

  it('maps NEAR tokens: native sentinels, Sui coin types, Tron base58, Hypercore HIP-1 only', async () => {
    const api = (nearIntentsBridgeProvider as unknown as { api: { getTokens(): Promise<object[]> } }).api
    const spy = jest
      .spyOn(api, 'getTokens')
      .mockResolvedValue([
        nearToken('sui', 'SUI', 9),
        nearToken('sui', 'USDC', 6, SUI_USDC),
        nearToken('tron', 'TRX', 6),
        nearToken('tron', 'USDT', 6, TRON_USDT),
        nearToken('hypercore', 'USDC', 8, HL_USDC_HIP1),
        nearToken('hypercore', 'USDC', 6, HL_USDC_ERC20),
      ])
    const sui = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: SUI_CHAIN_ID as TargetChainId })
    expect(sui.tokens.map((t) => [t.symbol, t.address])).toEqual([
      ['SUI', SUI_NATIVE_CURRENCY_ADDRESS],
      ['USDC', SUI_USDC],
    ])
    const tron = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: TRON_CHAIN_ID as TargetChainId })
    expect(tron.tokens.map((t) => [t.symbol, t.address])).toEqual([
      ['TRX', TRX_NATIVE_CURRENCY_ADDRESS],
      ['USDT', TRON_USDT],
    ])
    const hl = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: HYPERCORE_CHAIN_ID as TargetChainId })
    expect(hl.tokens.map((t) => t.address)).toEqual([HL_USDC_HIP1])
    expect(hl.isRouteAvailable).toBe(true)
    spy.mockRestore()
  })

  it('quotes 1Click EXACT_INPUT for Hypercore (its assets reject FLEX_INPUT) and FLEX_INPUT elsewhere', async () => {
    const MAINNET_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
    const api = (
      nearIntentsBridgeProvider as unknown as {
        api: { getTokens(): Promise<object[]>; getQuote(r: object): Promise<object> }
      }
    ).api
    const tokens = jest
      .spyOn(api, 'getTokens')
      .mockResolvedValue([
        nearToken('eth', 'USDT', 6, MAINNET_USDT),
        nearToken('sui', 'USDC', 6, SUI_USDC),
        nearToken('hypercore', 'USDC', 8, HL_USDC_HIP1),
      ])
    const sent: { swapType?: string; amount?: string }[] = []
    const quote = jest.spyOn(api, 'getQuote').mockImplementation(async (request) => {
      sent.push(request as { swapType?: string; amount?: string })
      throw new Error('captured')
    })
    const request = (buyTokenChainId: number, buyTokenAddress: string): QuoteBridgeRequest =>
      ({
        kind: OrderKind.SELL,
        amount: 1_000_000n,
        sellTokenChainId: SupportedChainId.MAINNET,
        sellTokenAddress: MAINNET_USDT,
        sellTokenDecimals: 6,
        buyTokenChainId: buyTokenChainId as TargetChainId,
        buyTokenAddress,
        buyTokenDecimals: 6,
        account: EVM_ADDR,
        receiver: EVM_ADDR,
        appCode: 'test',
      }) as QuoteBridgeRequest

    await expect(nearIntentsBridgeProvider.getQuote(request(HYPERCORE_CHAIN_ID, HL_USDC_HIP1))).rejects.toThrow(
      'captured',
    )
    await expect(nearIntentsBridgeProvider.getQuote(request(SUI_CHAIN_ID, SUI_USDC))).rejects.toThrow('captured')
    expect(sent.map((r) => [r.swapType, r.amount])).toEqual([
      ['EXACT_INPUT', '1000000'],
      ['FLEX_INPUT', '1000000'],
    ])
    tokens.mockRestore()
    quote.mockRestore()
  })

  it('is wired like the EVM pair: picker lists, native semantics, explorer links, shortening', () => {
    expect(SORTED_DST_CHAIN_IDS).toEqual(expect.arrayContaining([SUI_CHAIN_ID, TRON_CHAIN_ID, HYPERCORE_CHAIN_ID]))
    for (const id of [SUI_CHAIN_ID, TRON_CHAIN_ID, HYPERCORE_CHAIN_ID]) {
      expect(isBridgeOnlyDestinationChain(id)).toBe(true)
      expect(isEvmChain(id)).toBe(false)
      expect(isNonEvmRecipientChain(id)).toBe(true)
      expect(getChainInfo(id as TargetChainId).label).toBeTruthy()
    }
    expect(getIsNativeToken(SUI_CHAIN_ID as SupportedChainId, SUI_NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(getWrappedToken(NATIVE_CURRENCIES[TRON_CHAIN_ID as TargetChainId]).symbol).toBe('TRX')
    expect(getExplorerLink(SUI_CHAIN_ID, SUI_ADDR, ExplorerDataType.ADDRESS)).toBe(
      `https://suiscan.xyz/mainnet/account/${SUI_ADDR}`,
    )
    expect(getExplorerLink(TRON_CHAIN_ID, TRON_USDT, ExplorerDataType.ADDRESS)).toBe(
      `https://tronscan.org/#/address/${TRON_USDT}`,
    )
    expect(getExplorerLink(HYPERCORE_CHAIN_ID, EVM_ADDR, ExplorerDataType.ADDRESS)).toBe(
      `https://app.hyperliquid.xyz/explorer/address/${EVM_ADDR}`,
    )
    // The recipient panel's link builder (getBlockExplorerUrl) resolves the same explorers.
    expect(getBlockExplorerUrl(SUI_CHAIN_ID as SupportedChainId, 'address', SUI_ADDR)).toBe(
      `https://suiscan.xyz/mainnet/account/${SUI_ADDR}`,
    )
    expect(getBlockExplorerUrl(TRON_CHAIN_ID as SupportedChainId, 'address', TRON_USDT)).toBe(
      `https://tronscan.org/#/address/${TRON_USDT}`,
    )
    // shortenAddress used to throw on anything that was not EVM / BTC / Solana.
    expect(shortenAddress(SUI_ADDR)).toMatch(/^0x0000\.\.\.0002$/)
    expect(shortenAddress(TRON_USDT)).toMatch(/^TR7NHq\.\.\.Lj6t$/)
  })

  it("routes token links through each explorer's token page, not its account page (Codex P2)", () => {
    // ClickableAddress builds the token-details "View on explorer" link with ExplorerDataType.TOKEN.
    expect(getExplorerLink(SUI_CHAIN_ID, SUI_USDC, ExplorerDataType.TOKEN)).toBe(
      `https://suiscan.xyz/mainnet/coin/${SUI_USDC}`,
    )
    expect(getExplorerLink(TRON_CHAIN_ID, TRON_USDT, ExplorerDataType.TOKEN)).toBe(
      `https://tronscan.org/#/token20/${TRON_USDT}`,
    )
    expect(getExplorerLink(HYPERCORE_CHAIN_ID, HL_USDC_HIP1, ExplorerDataType.TOKEN)).toBe(
      `https://app.hyperliquid.xyz/explorer/token/${HL_USDC_HIP1}`,
    )
    // Account links keep the account route.
    expect(getExplorerLink(SUI_CHAIN_ID, SUI_ADDR, ExplorerDataType.ADDRESS)).toBe(
      `https://suiscan.xyz/mainnet/account/${SUI_ADDR}`,
    )
    // The legacy builder agrees.
    expect(getBlockExplorerUrl(SUI_CHAIN_ID as SupportedChainId, 'token', SUI_USDC)).toBe(
      `https://suiscan.xyz/mainnet/coin/${SUI_USDC}`,
    )
    expect(getBlockExplorerUrl(TRON_CHAIN_ID as SupportedChainId, 'token', TRON_USDT)).toBe(
      `https://tronscan.org/#/token20/${TRON_USDT}`,
    )
  })

  it('routes the destination fill transaction link through each explorer (Tronscan uses /transaction) (Codex round 2)', () => {
    const hash = '28b3c179f143eed895fca183cab9bc45ff54b316bb6658dedbc1573d668e9e85'
    expect(getExplorerLink(TRON_CHAIN_ID, hash, ExplorerDataType.TRANSACTION)).toBe(
      `https://tronscan.org/#/transaction/${hash}`,
    )
    expect(getExplorerLink(SUI_CHAIN_ID, hash, ExplorerDataType.TRANSACTION)).toBe(
      `https://suiscan.xyz/mainnet/tx/${hash}`,
    )
    expect(getExplorerLink(HYPERCORE_CHAIN_ID, hash, ExplorerDataType.TRANSACTION)).toBe(
      `https://app.hyperliquid.xyz/explorer/tx/${hash}`,
    )
    expect(getBlockExplorerUrl(TRON_CHAIN_ID as SupportedChainId, 'transaction', hash)).toBe(
      `https://tronscan.org/#/transaction/${hash}`,
    )
    // Trading chains keep the Ophis explorer tx route.
    expect(getExplorerLink(SupportedChainId.MAINNET, hash, ExplorerDataType.TRANSACTION)).toMatch(/\/tx\/28b3c179/)
  })

  it('keeps case-sensitive Tron and Sui token ids verbatim through recent-token storage (Codex round 2)', () => {
    // getAddressKey lowercases EVM addresses only; base58 and Move types pass through untouched,
    // so a stored Tron/Sui token survives the reload-time validity check.
    const tron = new TokenWithLogo(undefined, TRON_CHAIN_ID, TRON_USDT, 6, 'USDT', 'Tether USD')
    const sui = new TokenWithLogo(undefined, SUI_CHAIN_ID, SUI_USDC, 6, 'USDC', 'USD Coin')
    const stored = recentTokensStorage.buildNextStoredTokens(
      recentTokensStorage.buildNextStoredTokens({}, tron, 4),
      sui,
      4,
    )
    expect(stored[TRON_CHAIN_ID][0].address).toBe(TRON_USDT)
    expect(stored[SUI_CHAIN_ID][0].address).toBe(SUI_USDC)
    recentTokensStorage.persistStoredTokens(stored)
    const reloaded = recentTokensStorage.readStoredTokens(4)
    expect(reloaded[TRON_CHAIN_ID]?.[0]?.address).toBe(TRON_USDT)
    expect(reloaded[SUI_CHAIN_ID]?.[0]?.address).toBe(SUI_USDC)
  })
})
