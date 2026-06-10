import { recoverMessageAddress, isAddress } from 'viem';

// Signature-gated access for the Partner dashboard.
//
// The Partner dashboard is NOT public: it is visible only to whitelisted partner
// addresses (= the referrer_wallet of an ACTIVE partner-kind ref_code), and a
// wallet signature proves ownership so one partner can never read another's data.
//
// Flow: the frontend has the connected wallet personal_sign a short message that
// embeds the address + an issue timestamp. This module recovers the signer and
// checks (a) the recovered signer equals the claimed address, and (b) the message
// is within the replay window. The ROUTE then checks the recovered address is a
// whitelisted partner AND equals the requested :wallet — the DB whitelist check is
// kept out of here so this stays a pure, unit-testable crypto boundary.

/** Replay window: a signed access message is valid for this many seconds. */
export const PARTNER_SIG_MAX_AGE_SEC = 300;
/** Small allowance for client/server clock skew (seconds). */
const CLOCK_SKEW_SEC = 60;

/**
 * The exact message the wallet signs. Namespaced by the app + ACTION string so a
 * signature captured for one Ophis flow (e.g. dashboard access) cannot be replayed
 * for another (e.g. minting a code), and vice-versa. Address is lowercased for a
 * stable, case-insensitive comparison.
 */
export function buildSignedActionMessage(action: string, address: string, issuedSec: number): string {
  return `Ophis ${action}\nAddress: ${address.toLowerCase()}\nIssued: ${issuedSec}`;
}

/** Partner-dashboard access message (back-compat wrapper). */
export function buildPartnerAuthMessage(address: string, issuedSec: number): string {
  return buildSignedActionMessage('Partner Dashboard access', address, issuedSec);
}

export interface PartnerAuthInput {
  /** The action being authorized (namespaces the signature). Defaults to dashboard access. */
  readonly action?: string;
  /** The address the caller claims to be (and the dashboard they request). */
  readonly address: string;
  /** Unix seconds embedded in the signed message. */
  readonly issued: number;
  readonly signature: `0x${string}`;
  /** Server's current unix seconds (injected for testability). */
  readonly nowSec: number;
}

export type PartnerAuthResult =
  | { readonly ok: true; readonly address: `0x${string}` }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a partner-dashboard access signature. On success returns the recovered
 * (lowercased) address, which the caller must then check against the partner
 * whitelist and the requested :wallet. Pure except for viem's async recovery.
 *
 * Rejects: malformed address, non-integer/future/expired timestamp, malformed
 * signature, and a signer that does not match the claimed address.
 */
export async function verifyPartnerAuth(input: PartnerAuthInput): Promise<PartnerAuthResult> {
  const { address, issued, signature, nowSec } = input;

  if (typeof address !== 'string' || !isAddress(address)) {
    return { ok: false, reason: 'invalid address' };
  }
  if (!Number.isInteger(issued)) {
    return { ok: false, reason: 'invalid issued timestamp' };
  }
  // Reject timestamps in the future (beyond skew) — prevents pre-signing far-dated tokens.
  if (issued > nowSec + CLOCK_SKEW_SEC) {
    return { ok: false, reason: 'issued timestamp is in the future' };
  }
  // Reject stale signatures — bounds replay.
  if (issued < nowSec - PARTNER_SIG_MAX_AGE_SEC) {
    return { ok: false, reason: 'signature expired' };
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, reason: 'invalid signature' };
  }

  const message = buildSignedActionMessage(input.action ?? 'Partner Dashboard access', address, issued);
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return { ok: false, reason: 'signature recovery failed' };
  }

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: 'signer does not match claimed address' };
  }

  return { ok: true, address: recovered.toLowerCase() as `0x${string}` };
}
