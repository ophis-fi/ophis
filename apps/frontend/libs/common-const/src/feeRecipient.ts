import { mapAddressToSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

/**
 * Ophis partner-fee recipient. CREATE2-deterministic Safe; the same address
 * resolves on every chain where Safe's `SafeProxyFactory` is deployed. Safe
 * itself is lazy-deployed per chain — funds sent to a chain where the proxy
 * isn't yet deployed are still receivable; the proxy is deployed when
 * payouts there warrant the gas to spend them.
 *
 * Source of truth: `packages/sdk/src/partner-fee.ts` (`OPHIS_PARTNER_FEE_RECIPIENT`).
 * Mirrored at `apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts`
 * (`OPHIS_PARTNER_FEE_RECIPIENT`). All three constants MUST agree —
 * `feeRecipient.test.ts` enforces this against a hardcoded literal in
 * each test file.
 *
 * Phase 3 audit H1 (2026-05-19): the prior implementation routed Ophis-
 * operated chains 4326 (MegaETH) and 999 (HyperEVM) to wrong addresses:
 *   - MegaETH → `0x22af…2A76` (the CoW default placeholder), so partner
 *     fees from MegaETH would have leaked to a non-Ophis recipient.
 *   - HL (999) → `0xe049…01cF` (the *protocol* Safe — the governance
 *     multisig, NOT the partner-fee recipient).
 * Both now correctly route to the canonical `0x858f…CeF8`.
 */
export const OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as const

/**
 * Per-chain partner-fee recipient. The base mapping (`mapAddressToSupportedNetworks`)
 * uses the CoW default placeholder `0x22af…2A76` — that's intentional: this
 * map is consumed by the widget-configurator at
 * `apps/widget-configurator/src/app/configurator/index.tsx:237` for THIRD-PARTY
 * widget embeds. Sending Ophis fees from a third-party host's traffic on
 * Ethereum/Gnosis/Base/Arbitrum/etc. is wrong — they get the CoW default.
 *
 * Only the 3 chains we actually operate Ophis stacks on (10/4326/999)
 * override to the Ophis Safe.
 *
 * Sharp-edges MED-3 (pre-PR review caught the first cut routing all 10
 * CoW chains to Ophis — reverted to placeholder-base + 3 explicit
 * overrides).
 */
export const DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK: Record<SupportedChainId, string> = {
  ...mapAddressToSupportedNetworks('0x22af3D38E50ddedeb7C47f36faB321eC3Bb72A76'),
  [10 as unknown as SupportedChainId]: OPHIS_PARTNER_FEE_RECIPIENT,
  [4326 as unknown as SupportedChainId]: OPHIS_PARTNER_FEE_RECIPIENT,
  [999 as unknown as SupportedChainId]: OPHIS_PARTNER_FEE_RECIPIENT,
}
