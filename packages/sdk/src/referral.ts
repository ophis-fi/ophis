/**
 * Referral-code attribution via order appData.
 *
 * An Ophis referral code embedded in a CoW order's appData (under
 * `metadata.ophisReferrer.code`) credits that code's owner for the trade's
 * volume in the affiliate program WITHOUT the end user signing a separate
 * `?ref` bind. This is how an agent builder makes every order their agent
 * routes attributable to their own referral code. The Ophis rebate indexer
 * reads this field at accrual time.
 *
 * The code grammar MUST match the rebate indexer's ref-code grammar
 * (lowercase letters, digits, `_`, `-`; length 3-64) so a code that
 * round-trips through appData matches a row in the indexer's `ref_codes`
 * table. Keep this regex in sync with the indexer's `/^[a-z0-9_-]{3,64}$/`.
 */
const OPHIS_REFERRAL_CODE_RE = /^[a-z0-9_-]{3,64}$/;

export interface OphisReferrerTag {
  readonly code: string;
}

/**
 * Normalize (trim + lowercase) and validate a referral code. Throws on a code
 * that cannot exist in the registry (wrong grammar), so a typo fails loudly at
 * build time instead of silently producing an unattributable order.
 */
export function normalizeOphisReferralCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!OPHIS_REFERRAL_CODE_RE.test(normalized)) {
    throw new Error(
      'Invalid Ophis referral code: must be 3-64 chars of lowercase letters, digits, "_" or "-".',
    );
  }
  return normalized;
}

/**
 * Build the appData metadata fragment that tags an order with a referral code.
 * Merge the returned object into your order's appData `metadata`:
 *
 *   const metadata = { ...otherMetadata, ...buildOphisReferrerMetadata('acme') }
 *
 * which yields `metadata.ophisReferrer.code === 'acme'`.
 *
 * The code is OPTIONAL: called with no code (or an empty string) it returns
 * `{}`, so an order can be built and settled WITHOUT a referral (it still
 * carries the Ophis partner fee) and simply earns no rebate. This lets an agent
 * builder swap out of the box and add a code later to start earning.
 */
export function buildOphisReferrerMetadata(code?: string): { ophisReferrer?: OphisReferrerTag } {
  if (!code) return {};
  return { ophisReferrer: { code: normalizeOphisReferralCode(code) } };
}
