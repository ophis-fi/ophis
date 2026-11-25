// Helpers for working with OrderIntent

import { OrderKind } from "./generated/index.js";

// re-export
export { OrderKind } from "./generated/index.js";

// The bit each field occupies. Bit 0 is reserved for off-chain orders.
const KIND = 1 << 1;
const PARTIALLY_FILLABLE = 1 << 2;

// Every bit the encoding defines; the others are reserved.
const DEFINED = KIND | PARTIALLY_FILLABLE;

/** The settings an `OrderIntent`'s `flags` byte packs. */
export type Flags = {
  /**
   * Whether `sellAmount` or `buyAmount` is the exact figure; the other side is
   * treated as the limit (minimum to receive for `Sell`, maximum to spend for
   * `Buy`).
   */
  kind: OrderKind;

  /**
   * If `true`, the order may be filled across multiple settlements. If `false`,
   * a single settlement must consume the full sell amount (fill-or-kill).
   */
  partiallyFillable: boolean;
};

/** Packs the settings into a valid canonical flags byte. */
export function encodeFlags({ kind, partiallyFillable }: Flags): number {
  return (kind === OrderKind.Buy ? KIND : 0) | (partiallyFillable ? PARTIALLY_FILLABLE : 0);
}

/**
 * Unpacks a flags byte. Throws if a reserved bit is set.
 */
export function decodeFlags(byte: number): Flags {
  if (byte < 0 || byte > 0xff || (byte & ~DEFINED) !== 0) {
    throw new Error(`flags byte ${byte} sets a reserved bit`);
  }
  return {
    kind: (byte & KIND) === 0 ? OrderKind.Sell : OrderKind.Buy,
    partiallyFillable: (byte & PARTIALLY_FILLABLE) !== 0,
  };
}
