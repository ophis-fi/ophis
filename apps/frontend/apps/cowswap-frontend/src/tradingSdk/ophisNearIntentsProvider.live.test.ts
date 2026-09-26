import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'
import { BridgeStatus } from '@cowprotocol/sdk-bridging'

import { utils } from 'ethers'
import { getAddress, type Hex } from 'viem'

import { BRIDGE_QUOTE_ACCOUNT } from 'modules/tradeQuote'

import { OphisNearIntentsBridgeProvider } from './ophisNearIntentsProvider.service'

// Opt-in preflight: creates unfunded quotes and verifies real deposit attestations.
// OPHIS_NEAR_LIVE=1 NEAR_PREFLIGHT_API_KEY=<partner JWT> pnpm exec jest --runInBand
//   --config apps/cowswap-frontend/jest.config.ts --runTestsByPath <this file>
const live = process.env.OPHIS_NEAR_LIVE === '1' ? describe : describe.skip

class LiveNearProvider extends OphisNearIntentsBridgeProvider {
  getTokens(): ReturnType<OphisNearIntentsBridgeProvider['api']['getTokens']> {
    return this.api.getTokens()
  }
}

live('NEAR Robinhood live quotes and deposit attestations', () => {
  const results = { attested: 0, unavailable: 0 }
  beforeAll(() => {
    if (!process.env.NEAR_PREFLIGHT_API_KEY) throw new Error('NEAR_PREFLIGHT_API_KEY is required')
    const actualFetch = global.fetch
    jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('User-Agent', 'Mozilla/5.0')
      return actualFetch(input, { ...init, headers })
    })
  })
  afterAll(() => {
    jest.restoreAllMocks()
    console.info('[NEAR preflight]', results)
  })

  it.each(['USDG', 'PONS', 'CASHCAT', 'ETH', 'WETH', 'USDe'])(
    '%s returns attested quotes or explicitly unavailable liquidity, public and confidential',
    async (symbol) => {
      for (const confidentiality of [undefined, 'basic'] as const) {
        const provider = new LiveNearProvider({ apiKey: process.env.NEAR_PREFLIGHT_API_KEY, confidentiality })
        const tokens = await provider.getTokens()
        const hood = tokens.find((t) => String(t.blockchain) === 'hood' && t.symbol === symbol)
        const base = tokens.find((t) => String(t.blockchain) === 'base' && t.symbol === 'USDC')
        if (!hood || !base) throw new Error(`Missing ${symbol} or Base USDC`)

        for (const [source, destination] of [
          [hood, base],
          [base, hood],
        ]) {
          if (!(source.price > 0)) throw new Error('Missing source price')
          const sourceChainId = String(source.blockchain) === 'hood' ? 4663 : SupportedChainId.BASE
          const targetChainId = String(destination.blockchain) === 'hood' ? 4663 : SupportedChainId.BASE
          const quote = await provider
            .getQuote({
              kind: OrderKind.SELL,
              amount: BigInt(utils.parseUnits((100 / source.price).toFixed(6), source.decimals).toString()),
              sellTokenChainId: sourceChainId as SupportedChainId,
              sellTokenAddress: source.contractAddress ?? NATIVE_CURRENCY_ADDRESS,
              sellTokenDecimals: source.decimals,
              buyTokenChainId: targetChainId as TargetChainId,
              buyTokenAddress: destination.contractAddress ?? NATIVE_CURRENCY_ADDRESS,
              buyTokenDecimals: destination.decimals,
              account: getAddress(BRIDGE_QUOTE_ACCOUNT) as Hex,
              receiver: BRIDGE_QUOTE_ACCOUNT,
              appCode: 'ophis',
            })
            .catch((error: unknown) => {
              const body = error instanceof Error && 'body' in error ? error.body : undefined
              // Live inventory varies. USDG is the required baseline corridor; other
              // assets may explicitly refuse liquidity, but must never return an unchecked quote.
              if (
                symbol !== 'USDG' &&
                body &&
                typeof body === 'object' &&
                'message' in body &&
                body.message === 'No liquidity available'
              ) {
                results.unavailable++
                console.info(
                  `[NEAR preflight] ${symbol} ${sourceChainId}->${targetChainId} ${confidentiality ?? 'public'}: no liquidity`,
                )
                return null
              }
              const detail = body ? JSON.stringify(body) : String(error)
              throw new Error(`${symbol} ${sourceChainId}->${targetChainId} ${confidentiality ?? 'public'}: ${detail}`)
            })
          if (!quote) continue
          // getQuote rejects unless the deposit attestation recovers NEAR's signer.
          expect(utils.isAddress(quote.depositAddress)).toBe(true)
          expect(quote.amountsAndCosts.afterSlippage.buyAmount).toBeGreaterThan(0n)
          if (symbol === 'USDG') {
            expect((await provider.getStatus(quote.depositAddress, sourceChainId as SupportedChainId)).status).toBe(
              BridgeStatus.IN_PROGRESS,
            )
          }
          results.attested++
        }
      }
    },
    60_000,
  )
})
