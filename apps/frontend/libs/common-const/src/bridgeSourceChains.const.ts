import { SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Ink (57073) and Linea (59144) become Across bridge SOURCES once the Across
 * math helper is deployed on each (contracts/script/DeployAcrossMathHelper.s.sol,
 * deterministic at 0xEdE97D044d4C8aAA682968bee10284521B9f311a) and registered in
 * the sdk-bridging patch. This flag stages that switch: it stays OFF until the
 * helper is live, so merging the source-enabling code never advertises a corridor
 * whose deposit hook would CALL a codeless address. Flip it — set
 * REACT_APP_ACROSS_INK_LINEA_SOURCE=true in cloudflare-deploy.yml — only after the
 * deploy is confirmed on BOTH chains.
 */
export const ACROSS_INK_LINEA_SOURCE_ENABLED = process.env.REACT_APP_ACROSS_INK_LINEA_SOURCE === 'true'

/**
 * Pure gate for the flagged additions, so both branches are testable without
 * re-evaluating the module under a mutated env.
 */
export function acrossInkLineaSourceIds(enabled: boolean): readonly number[] {
  return enabled ? [SupportedChainId.INK, SupportedChainId.LINEA] : []
}

/**
 * The extra Across source chains the math-helper deploy unlocks; empty until the
 * flag flips. Single source of truth so BRIDGE_SOURCE_CHAIN_IDS (below) and
 * ACROSS_EXECUTABLE_SOURCE_IDS (ophisBridgeProviders.ts) can never disagree about
 * which chains are executable Across sources.
 */
export const EXTRA_ACROSS_SOURCE_CHAIN_IDS: readonly number[] = acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED)

/**
 * Chains a cross-chain (bridge) order can be CREATED from — the sell side.
 *
 * Source and destination support are asymmetric: a DESTINATION only needs the
 * bridge provider's API to deliver there (see OphisAcrossBridgeProvider /
 * OphisBungeeBridgeProvider, which widen destinations), while a SOURCE chain
 * needs execution machinery on-chain: NEAR Intents settles via an attested
 * deposit-address receiver (any chain it lists), but Across/Bungee build
 * post-swap hooks via CoW Shed, and Across additionally needs a math-helper
 * contract that upstream only deployed on Ethereum/Arbitrum/Base.
 *
 * This set is the union of chains at least one provider can execute FROM with
 * sdk-bridging 4.0.2 — exactly the effective source set before destinations
 * were widened, so widening destinations cannot accidentally offer bridging
 * from a chain where every quote would fail. Ink and Linea join via the flagged
 * EXTRA_ACROSS_SOURCE_CHAIN_IDS above (a math-helper deploy, no CoW Shed or
 * own-driver work — those chains ride upstream CoW solvers). Unichain and
 * Robinhood Chain sources remain future: they are sovereign, so they also need a
 * CoW Shed factory deploy and an E2E hook-execution proof on our own driver.
 */
export const BRIDGE_SOURCE_CHAIN_IDS: ReadonlySet<number> = new Set<number>([
  SupportedChainId.MAINNET,
  SupportedChainId.BNB,
  SupportedChainId.GNOSIS_CHAIN,
  SupportedChainId.POLYGON,
  SupportedChainId.BASE,
  SupportedChainId.PLASMA,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.AVALANCHE,
  // Optimism (Ophis sovereign): NEAR Intents lists it as a source, and its
  // deposit-address model needs only a plain swap with an overridden receiver.
  10,
  // Ink + Linea, gated behind the deploy flag above (empty until enabled).
  ...EXTRA_ACROSS_SOURCE_CHAIN_IDS,
])
