/** Dependency-free guards shared across the Ophis SDK helpers. */

/**
 * Throws if `chainId` is not a positive integer. This makes the common
 * "forgot to pass the chainId" mistake fail loudly instead of silently
 * flowing `undefined` through chain lookups (which would otherwise be
 * indistinguishable from a valid-but-unsupported chain).
 */
export const assertValidChainId = (chainId: number): void => {
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    throw new TypeError(
      `Ophis: chainId must be a positive integer, received ${String(chainId)}. ` +
        'Did you forget to pass it? e.g. ophisDefaultPartnerFee(10)',
    );
  }
};

/**
 * Format-only address check (0x + 40 hex chars). Does NOT verify the EIP-55
 * checksum — addresses are case-insensitive on-chain; the checksum is only a
 * typo guard, and validating it would require a keccak dependency.
 */
export const isAddressLike = (value: unknown): value is `0x${string}` =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/** Asserts `value` looks like an address; throws a TypeError otherwise. */
export function assertAddressLike(value: unknown, label = 'address'): asserts value is `0x${string}` {
  if (!isAddressLike(value)) {
    throw new TypeError(
      `Ophis: ${label} must be a 0x-prefixed 40-hex-char address, received ${String(value)}.`,
    );
  }
}

/** Case-insensitive address equality. */
export const addressesEqual = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** True for the zero address. CoW treats a zero/absent `receiver` as "send to the order owner". */
export const isZeroAddress = (value: string): boolean => addressesEqual(value, ZERO_ADDRESS);
