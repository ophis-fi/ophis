import { DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK, OPHIS_PARTNER_FEE_RECIPIENT } from '@cowprotocol/common-const'

/**
 * Returns true if the connected chain should embed Ophis's CIP-75 partner-fee
 * metadata into appData. Phase 3 audit H3 (2026-05-19): the
 * `injectedWidgetAppDataPartnerFeeAtom` previously emitted the partner-fee
 * config unconditionally regardless of chain — orders signed on chains
 * Ophis doesn't operate on still got `recipient = 0x858f…CeF8` embedded in
 * their appData, polluting data and risking attribution drift on chains
 * where the partner-fee Safe isn't even lazy-deployed.
 *
 * The chain-eligibility rule is driven by the canonicalized
 * `DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK` (Phase 3 H1 fix): a chain is
 * "Ophis-active" iff its entry in that map equals the canonical Ophis
 * recipient. Today that's exactly chains 10, 4326, 999 (Ophis-operated
 * deployments); other CoW chains route to the upstream CoW placeholder.
 */
export function shouldEmitOphisPartnerFee(chainId: number | undefined): boolean {
  if (chainId === undefined) return false
  const recipient = (DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK as Record<number, string>)[chainId]
  if (!recipient) return false
  // Case-insensitive compare (sharp-edges MED-1, pre-PR review): an
  // address can be canonical EIP-55 OR all-lowercase OR all-uppercase
  // and still refer to the same on-chain account. A future map edit
  // that introduces a lowercased entry would silently flip this gate
  // to false → revenue leak. Compare normalized.
  //
  // TODO (sharp-edges MED-2): when Ophis introduces an Ophis-Safe-V2
  // on a chain, this gate will silently exclude it. Replace with
  // `OPHIS_PARTNER_FEE_RECIPIENTS: ReadonlySet<string>` (all
  // Ophis-controlled recipients) + `set.has(recipient.toLowerCase())`.
  return recipient.toLowerCase() === OPHIS_PARTNER_FEE_RECIPIENT.toLowerCase()
}
