import { SupportedChainId } from '@cowprotocol/cow-sdk'

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
 * from a chain where every quote would fail. Growing it (Unichain, Robinhood
 * Chain, Ink, Linea sources) requires per-chain contract deploys plus an E2E
 * hook-execution proof on our own settlement first.
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
])
