import { OPHIS_SAFE_ADDRESS } from '../safe/addresses.js';

// Pure appData -> partner-fee attribution for the restricted accrual feed (Phase B).
// NO db / network imports. This is the MONEY-CRITICAL mapping from the feed's collected
// `protocolFeeAmounts[]` back to each partner recipient. Verified against the backend
// (apps/backend/crates/app-data/src/app_data.rs + autopilot fee/mod.rs):
//   - metadata.partnerFee is an object OR array of `{ <policy>, recipient }`; ingress
//     accepts ONLY the flat Volume shape ({ volumeBps } or legacy { bps }).
//   - The feed supplies an aligned protocolFeeKinds array. Config-derived fee slots are
//     removed first; the remaining Volume slots align to allowed appData entries.
//   - An entry whose recipient is NOT allowed (not the Ophis Safe, and -- once the registry
//     is enabled -- not an active registered third party) is DROPPED with NO slot, which
//     shifts indices. The indexer cannot see the registry, so it aligns positionally ONLY
//     when the kept-candidate count EXACTLY matches the slot count; on any mismatch it
//     SKIPS attribution (fail-safe UNDER-payment + surfaced for review) rather than
//     mis-attributing money to the wrong recipient.
//   - All Volume fees on one trade share the same surplus token, so token can NEVER
//     disambiguate multiple partner entries -- only positional order can.

/** The Ophis partner-fee Safe (lowercased). Its partnerFee entry is Ophis's OWN retained
 *  fee, never a partner payout. */
const OPHIS_RECIPIENT_LOWER = OPHIS_SAFE_ADDRESS.toLowerCase();

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** One appData partnerFee entry the backend would keep (== one collected fee slot). */
export interface PartnerFeeCandidate {
  /** Lowercased 0x recipient. */
  readonly recipient: `0x${string}`;
  /** The entry's flat Volume rate (bps), or 0 if not a clean integer Volume shape. Reporting
   *  only -- the MONEY is the collected slot amount, never bps*volume. */
  readonly volumeBps: number;
}

/**
 * Parse `metadata.partnerFee` into the ordered list of kept candidates (one per entry with a
 * valid recipient address), preserving appData array order. A single object is treated as a
 * one-element array (matching the backend deserializer). Entries without a valid 20-byte
 * recipient are dropped (the backend could never allow them, so they emit no slot). Returns
 * `[]` for absent/malformed appData.
 */
export function parsePartnerFeeCandidates(fullAppData: string | null | undefined): PartnerFeeCandidate[] {
  if (!fullAppData) return [];
  let meta: unknown;
  try {
    meta = JSON.parse(fullAppData);
  } catch {
    return [];
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return [];
  const pf = (meta as { metadata?: { partnerFee?: unknown } })?.metadata?.partnerFee;
  if (pf === undefined || pf === null) return [];
  const entries = Array.isArray(pf) ? pf : [pf];

  const out: PartnerFeeCandidate[] = [];
  for (const e of entries) {
    const entry = e as { volumeBps?: unknown; bps?: unknown; recipient?: unknown };
    if (typeof entry?.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.recipient)) {
      continue; // no valid recipient -> the backend can't allow it -> no slot
    }
    const recipient = entry.recipient.toLowerCase() as `0x${string}`;
    const raw = entry.volumeBps !== undefined ? entry.volumeBps : entry.bps;
    const volumeBps = isInt(raw) && raw >= 0 ? raw : 0;
    out.push({ recipient, volumeBps });
  }
  return out;
}

/** A collected partner fee attributed to one recipient for one trade. */
export interface PartnerFeeAttribution {
  readonly recipient: `0x${string}`;
  readonly volumeBps: number;
  /** Lowercased 0x fee token (the surplus token). */
  readonly feeToken: `0x${string}`;
  /** The ACTUALLY-COLLECTED protocol fee amount (uint256 wei) for this recipient. */
  readonly feeAmount: bigint;
}

export interface AttributionResult {
  /** One entry per NON-Ophis recipient with a positive collected fee (summed across slots of
   *  the same recipient, so it satisfies the (trade_uid, recipient) primary key). */
  readonly attributions: PartnerFeeAttribution[];
  /** true iff there ARE non-Ophis candidates but the slot count did not match, so attribution
   *  was skipped for money-safety. The caller surfaces these for manual review. */
  readonly skipped: boolean;
  readonly reason?: string;
}

/**
 * Attribute a feed trade's collected protocol fees to its NON-Ophis partner recipients.
 * Positional zip of the ordered kept candidates onto `protocolFeeAmounts`/`protocolFeeTokens`,
 * gated by an EXACT count match (see the module header for why). Ophis-Safe slots are the
 * retained fee and are never emitted. Zero-amount slots emit nothing. Multiple slots for the
 * same recipient are SUMMED. The Ophis fee still occupies its slot, so it is included in the
 * candidate count for the positional alignment even though it yields no attribution.
 */
export function attributePartnerFees(row: {
  protocolFeeAmounts: readonly string[];
  protocolFeeTokens: readonly string[];
  protocolFeeKinds: readonly string[];
  fullAppData: string | null | undefined;
}): AttributionResult {
  const candidates = parsePartnerFeeCandidates(row.fullAppData);
  const nonOphis = candidates.filter((c) => c.recipient !== OPHIS_RECIPIENT_LOWER);
  // No third-party partner entry -> nothing to attribute (the Ophis-only fee is not a
  // partner payout). Not an error.
  if (nonOphis.length === 0) return { attributions: [], skipped: false };

  const amounts = row.protocolFeeAmounts;
  const tokens = row.protocolFeeTokens;
  const kinds = row.protocolFeeKinds;
  if (amounts.length !== tokens.length || amounts.length !== kinds.length) {
    return { attributions: [], skipped: true, reason: 'feed protocol fee arrays length mismatch' };
  }
  const volumeSlots = kinds
    .map((kind, index) => ({ kind, amount: amounts[index]!, token: tokens[index]! }))
    .filter((slot) => slot.kind.toLowerCase() === 'volume');
  // MONEY-SAFETY GUARD: only align positionally when every kept candidate has a slot. A
  // mismatch means an entry was dropped at settlement (unregistered/suspended recipient) or
  // an unexpected extra slot exists, so the index -> recipient mapping is ambiguous. Skip
  // (under-pay + surface) rather than risk paying a fee to the wrong recipient.
  if (candidates.length !== volumeSlots.length) {
    return {
      attributions: [],
      skipped: true,
      reason: `kept-candidate count ${candidates.length} != collected Volume-fee slot count ${volumeSlots.length}`,
    };
  }

  const byRecipient = new Map<`0x${string}`, { volumeBps: number; feeToken: `0x${string}`; feeAmount: bigint }>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.recipient === OPHIS_RECIPIENT_LOWER) continue; // Ophis retained fee, not a payout
    let amount: bigint;
    try {
      amount = BigInt(volumeSlots[i]!.amount);
    } catch {
      return { attributions: [], skipped: true, reason: `non-integer fee amount at slot ${i}` };
    }
    if (amount <= 0n) continue; // no fee collected for this slot
    const tokenRaw = volumeSlots[i]!.token;
    if (typeof tokenRaw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(tokenRaw)) {
      return { attributions: [], skipped: true, reason: `invalid fee token at slot ${i}` };
    }
    const feeToken = tokenRaw.toLowerCase() as `0x${string}`;
    const cur = byRecipient.get(c.recipient);
    if (cur) {
      // Same recipient across two slots: sum the amount + bps. Both slots share the surplus
      // token, so keeping one feeToken is correct.
      cur.feeAmount += amount;
      cur.volumeBps += c.volumeBps;
    } else {
      byRecipient.set(c.recipient, { volumeBps: c.volumeBps, feeToken, feeAmount: amount });
    }
  }

  const attributions: PartnerFeeAttribution[] = [...byRecipient.entries()].map(([recipient, v]) => ({
    recipient,
    volumeBps: v.volumeBps,
    feeToken: v.feeToken,
    feeAmount: v.feeAmount,
  }));
  return { attributions, skipped: false };
}
