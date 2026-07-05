// Fail-CLOSED allowlist of SOVEREIGN own-fee payout RECIPIENTS.
//
// An integrator stacks a partnerFee entry to their OWN recipient (next to the Ophis
// base entry) on Optimism (10) / Unichain (130). The fee is charged into the
// Settlement buffer and swept to the Ophis Safe. This set is the ONLY gate that lets
// the monthly own-fee payout send that swept WETH back OUT to a third-party recipient.
//
// EMPTY today: no third party is allowlisted yet, so the payout pays NO ONE (fail
// closed). This set MUST mirror the backend PARTNER_FEE_RECIPIENT_ALLOWLIST
// (apps/backend/crates/app-data/src/app_data.rs) MINUS the Ophis Safe, and it MUST be
// updated ONLY AFTER that backend allowlist is deployed on the sovereign chains.
// Adding a recipient here BEFORE the backend accepts its fee would try to pay a fee the
// autopilot dropped (the Safe never received it), so keep this set TRAILING the backend
// allowlist, never leading it.
//
// The Ophis Safe (own fee is swept TO it, never paid back out of the program) and the
// zero address are NEVER valid recipients; assertOwnFeeRecipientsSane enforces that at
// import time (fail closed) and is re-asserted in a test.

/** The Ophis partner-fee Safe, lowercased. Own fee is swept TO it, never paid FROM it. */
export const OPHIS_SAFE_LOWER = '0x858f0f5ee954846d47155f5203c04af1819ecef8';
export const ZERO_ADDRESS_LOWER = '0x0000000000000000000000000000000000000000';

/**
 * Lowercased 0x recipient addresses permitted to receive a sovereign own-fee payout.
 * INTENTIONALLY EMPTY. Add a third-party recipient ONLY after it is live in the backend
 * PARTNER_FEE_RECIPIENT_ALLOWLIST. Every entry MUST be an all-lowercase 0x address:
 * membership is checked by lowercasing the trade recipient and looking it up in this
 * RAW set, so a checksummed (mixed-case) entry would silently never match. Never the
 * Ophis Safe, never the zero address (assertOwnFeeRecipientsSane rejects all three, at
 * import time).
 */
export const SOVEREIGN_OWN_FEE_RECIPIENTS: ReadonlySet<string> = new Set<string>([
  // (empty)
]);

/**
 * Throw if the allowlist ever contains the Ophis Safe, the zero address, or a
 * non-address / NON-LOWERCASE entry. Every entry MUST already be all-lowercase: the
 * membership checks (isPayableOwnFeeRecipient + accrual) lowercase the trade recipient
 * and look it up in this RAW set, so a checksummed (mixed-case) entry would silently
 * never match and an onboarded partner would never be paid. We fail LOUD on such an
 * entry (fail-closed spirit) instead of normalizing it silently. A misconfigured set
 * stops the payout (and, at import time, every module that imports this one) rather
 * than paying wrong.
 */
export function assertOwnFeeRecipientsSane(
  set: ReadonlySet<string> = SOVEREIGN_OWN_FEE_RECIPIENTS,
): void {
  for (const raw of set) {
    // Validate the RAW entry against the lowercase 0x-address shape FIRST (do NOT
    // lowercase it before checking): a checksummed entry that we lowercased before
    // validating would pass here yet never match at lookup. Reject it loudly so the
    // operator switches to the all-lowercase form.
    if (!/^0x[0-9a-f]{40}$/.test(raw)) {
      throw new Error(
        `SOVEREIGN_OWN_FEE_RECIPIENTS entry must be an all-lowercase 0x address; got "${raw}". Use the lowercase form (a checksummed entry would never match the lowercased trade recipient).`,
      );
    }
    if (raw === OPHIS_SAFE_LOWER) {
      throw new Error(
        'SOVEREIGN_OWN_FEE_RECIPIENTS must NEVER contain the Ophis Safe (own fee is swept TO it, not paid back out)',
      );
    }
    if (raw === ZERO_ADDRESS_LOWER) {
      throw new Error('SOVEREIGN_OWN_FEE_RECIPIENTS must NEVER contain the zero address');
    }
  }
}

/** True iff addr is an allowlisted, payable own-fee recipient (never the Ophis Safe / zero). */
export function isPayableOwnFeeRecipient(
  addr: string,
  allowlist: ReadonlySet<string> = SOVEREIGN_OWN_FEE_RECIPIENTS,
): boolean {
  const a = addr.toLowerCase();
  if (a === OPHIS_SAFE_LOWER || a === ZERO_ADDRESS_LOWER) return false;
  return allowlist.has(a);
}

// Fail closed at import: a misconfigured allowlist throws everywhere it is imported.
assertOwnFeeRecipientsSane();
