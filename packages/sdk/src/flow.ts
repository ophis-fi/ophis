/**
 * High-level order-flow helpers that collapse the Ophis integration footguns
 * into single calls. The rest of @ophis/sdk is a set of primitives; this module
 * is the "do it right by default" layer on top.
 *
 * It stays DEPENDENCY-FREE: it does not import cow-sdk. The integrator still
 * calls cow-sdk for the quote, the appData hashing (MetadataApi.generateAppDataDoc
 * + stringifyDeterministic + keccak256), the signature, and OrderBookApi.sendOrder.
 * These helpers own the parts where partners silently get it wrong:
 *
 *   - appCode MUST be 'ophis' (a custom appCode makes the rebate indexer drop the
 *     order at accrual, with no error) -> buildOphisOrderMetadata hardcodes it.
 *   - the partner fee + referral tag must both ride in one metadata object
 *     -> buildOphisOrderMetadata assembles them.
 *   - each trading wallet must be registered with the rebate indexer or its
 *     trades are never fetched -> enrollOphisTrader.
 *   - the receiver must be the order owner (an unpinned receiver is a drain)
 *     and the sendOrder body wire shape is appData=full-string + appDataHash
 *     (NOT the hash as appData) -> buildOphisOrderCreation.
 */

import {
  OPHIS_PARTNER_FEE_RECIPIENT,
  ophisVolumeBpsForPair,
  OPHIS_FEE_CHAIN_IDS,
  type OphisPartnerFee,
} from './partner-fee.js';
import { buildOphisReferrerMetadata } from './referral.js';
import { assertReceiverIsOwner } from './order.js';
import { assertValidChainId, assertAddressLike, assertBytes32, addressesEqual } from './guards.js';

/** cow-sdk `SigningScheme` string values. EOAs use 'eip712'; Safe / MPC use 'eip1271'. */
export type OphisSigningScheme = 'eip712' | 'ethsign' | 'eip1271' | 'presign';

/** Production rebate-indexer host. The `/tier/:wallet` endpoint enrolls a wallet. */
export const OPHIS_REBATE_INDEXER_URL = 'https://rebates.ophis.fi';

const FEE_CHAIN_ID_SET: ReadonlySet<number> = new Set<number>(OPHIS_FEE_CHAIN_IDS);

/** True if Ophis charges its partner fee (and therefore pays a rebate) on this chain. */
export const isOphisFeeChain = (chainId: number): boolean => {
  assertValidChainId(chainId);
  return FEE_CHAIN_ID_SET.has(chainId);
};

export interface OphisOrderMetadataOptions {
  /** Chain the order settles on. Must be an Ophis-served chain. */
  readonly chainId: number;
  /** Your Ophis referral code. Earns the rebate; embedded in metadata.ophisReferrer.code. */
  readonly referralCode: string;
  /**
   * True ONLY for a same-chain stablecoin pair, which charges the reduced 1 bp
   * rate instead of the standard 10 bps. You decide this; the SDK is chain-only
   * and cannot detect the pair. Defaults to false. Setting it true for a pair
   * that is not actually stable-stable undercharges: on the OP self-hosted
   * backend the order is rejected at the 10 bps floor; on CoW-hosted chains it
   * may silently settle (and rebate) at 1/10th. When in doubt, leave it false.
   */
  readonly isStablePair?: boolean;
  /**
   * The smart-contract wallet (Safe / MPC) that signs via EIP-1271. Recommended
   * for contract signers (sets appData.metadata.signer). Omit for EOA signers.
   */
  readonly signer?: `0x${string}`;
}

/** The exact value to pass to cow-sdk's `MetadataApi.generateAppDataDoc(...)`. */
export interface OphisAppDataInput {
  /** Always the literal 'ophis'. A custom appCode silently forfeits the rebate. */
  readonly appCode: 'ophis';
  readonly metadata: {
    readonly partnerFee: OphisPartnerFee;
    readonly ophisReferrer: { readonly code: string };
    readonly signer?: `0x${string}`;
    readonly hooks: Record<string, never>;
  };
}

/**
 * Builds the appCode + metadata for an Ophis order in one call, getting the three
 * silent-failure details right: appCode is 'ophis' (NOT your app name; a custom
 * appCode makes the rebate indexer drop the order), the CIP-75 Volume partner fee
 * goes to the Ophis recipient at the correct rate, and your referral code is
 * tagged so the rebate accrues.
 *
 * Throws on a chain Ophis does not serve (so you never route an order that pays
 * no Ophis fee, and thus earns no rebate, by mistake).
 *
 * IMPORTANT: pass the ENTIRE return value to generateAppDataDoc. Do not pluck
 * `.metadata` and keep your own appCode: any appCode other than 'ophis' makes
 * the rebate indexer silently drop the order, and you forfeit every rebate with
 * no error anywhere.
 *
 * @example
 *   const doc = await new MetadataApi().generateAppDataDoc(
 *     buildOphisOrderMetadata({ chainId: 1, referralCode: 'yourcode' }),
 *   );
 */
export function buildOphisOrderMetadata(opts: OphisOrderMetadataOptions): OphisAppDataInput {
  const { chainId, referralCode, isStablePair = false, signer } = opts;
  if (!isOphisFeeChain(chainId)) {
    throw new Error(
      `Ophis: chain ${chainId} is not served by Ophis (OPHIS_FEE_CHAIN_IDS), so no partner fee ` +
        'or rebate applies there. Route it through your own venue, and only build an Ophis order ' +
        'on a served chain.',
    );
  }
  const partnerFee: OphisPartnerFee = {
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
    volumeBps: ophisVolumeBpsForPair(isStablePair),
  };
  // buildOphisReferrerMetadata validates the code grammar and throws on a typo.
  const { ophisReferrer } = buildOphisReferrerMetadata(referralCode);
  return {
    appCode: 'ophis',
    metadata: {
      partnerFee,
      ophisReferrer,
      ...(signer !== undefined ? { signer } : {}),
      hooks: {},
    },
  };
}

export interface EnrollOphisTraderOptions {
  /** Rebate-indexer host. Defaults to OPHIS_REBATE_INDEXER_URL. */
  readonly host?: string;
  /** Fetch implementation. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/**
 * Registers a trading wallet with the Ophis rebate indexer so its Ophis trades
 * are indexed and the referral rebate accrues. The indexer is owner-scoped (it
 * only fetches trades for wallets it knows), so a wallet that never connects to
 * an Ophis frontend is NEVER indexed unless enrolled here. Call this once per
 * trader wallet, on wallet-connect, before its first Ophis order.
 *
 * Idempotent (the endpoint upserts). Throws on a network error or non-2xx, so a
 * caller can block the first swap until enrollment succeeds.
 */
export async function enrollOphisTrader(
  wallet: string,
  opts: EnrollOphisTraderOptions = {},
): Promise<void> {
  assertAddressLike(wallet, 'wallet');
  const host = (opts.host ?? OPHIS_REBATE_INDEXER_URL).replace(/\/+$/, '');
  // The wallet address is in the request path; require a secure host (allowing a
  // local dev host) so it is never leaked over plaintext or to an unintended
  // origin. host should be a trusted constant, never request-controlled input.
  // Parse with the URL API, not a regex: a regex is bypassable (e.g.
  // `http://localhost:80@evil.com` has host `evil.com`, with `localhost` as userinfo).
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(`Ophis: invalid rebate-indexer host "${host}".`);
  }
  const isLocalDev =
    parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if ((parsed.protocol !== 'https:' && !isLocalDev) || parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `Ophis: rebate-indexer host must be https:// (or http://localhost for dev) with no embedded credentials, got "${host}".`,
    );
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('Ophis: no fetch implementation available; pass opts.fetch.');
  }
  const res = await doFetch(`${host}/tier/${wallet}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Ophis: failed to enroll ${wallet} with the rebate indexer (HTTP ${res.status}).`);
  }
}

export interface OphisOrderCreationOptions {
  /**
   * The signed CoW order object. Its `appData` field must be the bytes32 HASH
   * (the value that was signed). `receiver` must already be set on it.
   */
  readonly order: Record<string, unknown>;
  /** The order owner (the signer / from). The receiver is pinned to this. */
  readonly owner: `0x${string}`;
  /** The full deterministic appData JSON STRING (from stringifyDeterministic). */
  readonly fullAppData: string;
  /** The bytes32 appData hash (keccak256 of fullAppData). */
  readonly appDataHash: `0x${string}`;
  readonly signature: `0x${string}`;
  /** cow-sdk SigningScheme value, e.g. 'eip712' (EOA) or 'eip1271' (Safe / MPC). */
  readonly signingScheme: OphisSigningScheme;
  /**
   * Authorize a receiver OTHER than the owner by NAMING the exact address. Off by
   * default: an unpinned/foreign receiver is a drain vector. When set, the order's
   * own `receiver` must equal this address (so a stale or injected `order.receiver`
   * still throws). Omit it to pin proceeds to the owner.
   */
  readonly allowReceiver?: `0x${string}`;
}

/**
 * Builds the body for cow-sdk's `OrderBookApi.sendOrder(...)`, getting the two
 * order-killing details right:
 *
 *  - the WIRE SHAPE: the order is SIGNED with `appData` = the bytes32 hash, but
 *    SUBMITTED with `appData` = the full JSON STRING and `appDataHash` = the hash.
 *    `OrderCreation` has no `fullAppData` field; sending the hash as `appData`
 *    uses a deprecated form the orderbook is phasing out.
 *  - the RECEIVER: pinned to the owner and written EXPLICITLY into the body (a
 *    drain guard), unless allowReceiver names a different destination.
 *
 * NOTE: for the rebate to accrue, `owner` must already have been registered via
 * `enrollOphisTrader` (the indexer never fetches an unenrolled wallet's trades).
 * This builder does not enforce that ordering; enroll on wallet-connect.
 *
 * @example
 *   await orderBookApi.sendOrder(buildOphisOrderCreation({
 *     order, owner, fullAppData, appDataHash, signature, signingScheme: 'eip712',
 *   }));
 */
export function buildOphisOrderCreation(opts: OphisOrderCreationOptions): Record<string, unknown> {
  const { order, owner, fullAppData, appDataHash, signature, signingScheme, allowReceiver } = opts;
  assertAddressLike(owner, 'owner');
  // Catch the easy swap of passing the full appData JSON (or a truncated hash)
  // where the bytes32 hash belongs.
  assertBytes32(appDataHash, 'appDataHash');

  const rawReceiver = order.receiver as string | undefined;
  let receiver: `0x${string}`;
  if (allowReceiver !== undefined) {
    // Named opt-out: proceeds may go to allowReceiver, and order.receiver MUST
    // equal it, so a stale or injected order.receiver still throws.
    assertAddressLike(allowReceiver, 'allowReceiver');
    if (rawReceiver === undefined || !addressesEqual(rawReceiver, allowReceiver)) {
      throw new Error(
        `Ophis: order.receiver (${String(rawReceiver)}) does not match the authorized allowReceiver ${allowReceiver}. ` +
          'Set order.receiver to the address you intend, or remove allowReceiver to pin proceeds to the owner.',
      );
    }
    receiver = allowReceiver;
  } else {
    // Default drain guard: a foreign receiver throws; absent/zero is fine.
    assertReceiverIsOwner(owner, rawReceiver);
    receiver = owner; // write it explicitly: a proven pin, not just an asserted one.
  }
  return {
    ...order,
    from: owner,
    receiver, // explicit, never left for backend defaulting
    signingScheme,
    signature,
    appData: fullAppData, // FULL JSON STRING, not the hash
    appDataHash,
  };
}
