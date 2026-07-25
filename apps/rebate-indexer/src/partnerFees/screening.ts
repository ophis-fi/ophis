// Lightweight sanctions / list screening applied at partner-fee PAYOUT time (decision 21),
// on TOP of the existing dry-run quarantine. A screened-out recipient is QUARANTINED (never
// paid; its owed carries forward so it is never lost, and is re-attempted once cleared) -- the
// same terminal handling as a transfer that reverts at dry-run.
//
// This is deliberately a simple, operator-maintained address blocklist (not a live oracle
// call on the money path): the payout is human-signed monthly, so a fast fail-closed list +
// manual review is the right weight. Populate PARTNER_FEE_SANCTIONS_LIST (comma-separated
// lowercase 0x addresses) from whatever compliance source ops maintains; a built-in set can
// be added below. Zero address is always screened out (defense-in-depth).

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Built-in always-blocked addresses. INTENTIONALLY EMPTY beyond the zero address; the live
 * list comes from PARTNER_FEE_SANCTIONS_LIST so it can be updated without a redeploy.
 */
const BUILTIN_BLOCKLIST: ReadonlySet<string> = new Set<string>([ZERO_ADDRESS]);

/**
 * Parse PARTNER_FEE_SANCTIONS_LIST into a lowercased address set. Every entry MUST be an
 * all-lowercase 0x address (membership is by lowercased lookup, so a checksummed entry would
 * silently never match); a malformed entry THROWS (fail-loud), so a typo can't silently
 * disable screening for everyone. Returns the built-in set merged with the env entries.
 */
export function resolveSanctionsList(raw = process.env.PARTNER_FEE_SANCTIONS_LIST): ReadonlySet<string> {
  const set = new Set<string>(BUILTIN_BLOCKLIST);
  const trimmed = raw?.trim();
  if (!trimmed) return set;
  for (const part of trimmed.split(',')) {
    const a = part.trim();
    if (!a) continue;
    if (!/^0x[0-9a-f]{40}$/.test(a)) {
      throw new Error(`PARTNER_FEE_SANCTIONS_LIST entry must be an all-lowercase 0x address; got "${a}"`);
    }
    set.add(a);
  }
  return set;
}

/** True iff `recipient` must NOT be paid this cycle (sanctioned / zero address). */
export function isScreenedOut(recipient: string, blocklist: ReadonlySet<string> = resolveSanctionsList()): boolean {
  return blocklist.has(recipient.toLowerCase());
}
