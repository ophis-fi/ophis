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
 * Robinhood Chain (4663) as an Across bridge SOURCE. Kept as its OWN flag rather
 * than sharing one with other chains: readiness is per-chain, and a combined flag
 * would force enabling a chain that is not ready in order to enable one that is.
 *
 * 4663 is SOVEREIGN — Ophis runs its own settlement, autopilot, orderbook and
 * driver there, so unlike Ink/Linea (where upstream CoW solvers execute the
 * post-hook) OUR driver must. All of that is in place and verified on-chain
 * (2026-08-27): the Across SpokePool, the AcrossMathHelper, the CoW Shed factory
 * + implementation and the weiroll VM all have code on 4663 (the last two
 * byte-identical to mainnet by codehash), and the settlement-bound HooksTrampoline
 * 0x68593257…aC0E — the value the live orderbook advertises at
 * /api/v1/info/contracts — reports the Ophis 4663 settlement from settlement().
 *
 * Flip — set REACT_APP_ACROSS_ROBINHOOD_SOURCE=true in cloudflare-deploy.yml —
 * only after `pnpm across-source-preflight 4663` passes AND a real bridge FROM
 * 4663 has settled with a SpokePool FundsDeposited event. That last condition is
 * not ceremony: the HooksTrampoline discards the success flag of each hook call,
 * so a post-hook that reverts (or delegatecalls a codeless address, the
 * 2026-08-13 incident) still leaves the settlement successful while the deposit
 * never happens and the funds sit in the user's CoW Shed. Only the deposit event
 * proves the corridor.
 */
export const ACROSS_ROBINHOOD_SOURCE_ENABLED = process.env.REACT_APP_ACROSS_ROBINHOOD_SOURCE === 'true'

/**
 * Pure gate, same shape as acrossInkLineaSourceIds. 4663 is not a
 * SupportedChainId member (it is a custom bridge chain, see ophisBridgeChains.ts),
 * so the id is a literal.
 */
export function acrossRobinhoodSourceIds(enabled: boolean): readonly number[] {
  return enabled ? [4663] : []
}

/**
 * The extra Across source chains our own deploys unlock; each group is empty
 * until its own flag flips. Single source of truth so BRIDGE_SOURCE_CHAIN_IDS
 * (below) and ACROSS_EXECUTABLE_SOURCE_IDS (ophisBridgeProviders.ts) can never
 * disagree about which chains are executable Across sources.
 */
export const EXTRA_ACROSS_SOURCE_CHAIN_IDS: readonly number[] = [
  ...acrossInkLineaSourceIds(ACROSS_INK_LINEA_SOURCE_ENABLED),
  ...acrossRobinhoodSourceIds(ACROSS_ROBINHOOD_SOURCE_ENABLED),
]

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
