import { addressesEqual, assertAddressLike, isZeroAddress } from './guards.js';

/**
 * CoW order safety helpers for autonomous signers.
 *
 * Context: a CoW order carries a `receiver` field — the address that gets the
 * bought tokens on settlement. It is part of the EIP-712-signed payload and is
 * fully caller-controlled; the backend only defaults it to the owner when it is
 * absent/zero. For an autonomous agent (no human reading the wallet prompt) an
 * unpinned `receiver` is a direct drain vector: a bug, stale variable, or
 * prompt-injected value produces a VALID, non-repudiable signature that sends
 * funds to an attacker. So: pin `receiver` to the owner by default, and make a
 * non-owner receiver a deliberate, loudly-named opt-in.
 *
 * NOTE: these are off-chain MISUSE GUARDS, not an authorization boundary. They
 * stop the easy mistake; they cannot stop a compromised signer. Real autonomous
 * safety must be enforced on-chain (EIP-1271 policy validator / Safe module),
 * not by a caller remembering to invoke a helper.
 */

export interface ReceiverOptions {
  /**
   * Opt in to a non-owner receiver. Named "unsafe" on purpose: for an
   * autonomous signer this is the drain vector. Only pass a value you fully
   * control and intend to send proceeds to.
   */
  readonly unsafeCustomReceiver?: `0x${string}`;
}

/**
 * Resolves the `receiver` for a CoW order, pinned to `owner` unless an explicit
 * non-owner `unsafeCustomReceiver` is supplied. Throws on a malformed address.
 */
export const ophisOrderReceiver = (owner: `0x${string}`, opts: ReceiverOptions = {}): `0x${string}` => {
  assertAddressLike(owner, 'owner');
  const custom = opts.unsafeCustomReceiver;
  if (custom === undefined) return owner;
  assertAddressLike(custom, 'unsafeCustomReceiver');
  return custom;
};

export interface AssertReceiverOptions {
  /** Allow a non-owner receiver (must be explicitly enabled). Default false. */
  readonly allowCustomReceiver?: boolean;
}

/**
 * Pre-sign guard: throws unless `receiver` resolves to the owner. A zero or
 * `undefined` receiver is safe (CoW sends proceeds to the owner). Call this
 * immediately before signing/submitting an autonomous order.
 */
export const assertReceiverIsOwner = (
  owner: `0x${string}`,
  receiver: string | undefined,
  opts: AssertReceiverOptions = {},
): void => {
  assertAddressLike(owner, 'owner');
  if (receiver === undefined) return; // CoW treats an absent receiver as the owner
  assertAddressLike(receiver, 'receiver'); // validate format before any early-return
  if (isZeroAddress(receiver)) return; // CoW treats the zero receiver as the owner
  if (addressesEqual(receiver, owner)) return;
  if (opts.allowCustomReceiver) return;
  throw new Error(
    `Ophis: order receiver ${receiver} is not the owner ${owner}. ` +
      'Refusing to sign — proceeds would leave the account. ' +
      'Pass { allowCustomReceiver: true } only if this is intentional.',
  );
};
