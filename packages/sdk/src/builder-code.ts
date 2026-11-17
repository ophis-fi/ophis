import type { Hex } from 'viem';

export const OPHIS_BASE_BUILDER_CODE = 'bc_8j4gt5x6';
export const OPHIS_BASE_DATA_SUFFIX = '0x62635f386a3467743578360b0080218021802180218021802180218021';

/** Apply to public contract calls before estimation, never to initcode, signed messages or nested hooks. */
export function appendOphisBaseBuilderCode(data: Hex, chainId: number): Hex {
  if (chainId !== 8453) return data;
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error('Invalid transaction calldata');
  // Preserve receive/fallback calls and attribution already supplied by another builder or wallet.
  if (data.length < 10 || data.toLowerCase().endsWith('80218021802180218021802180218021')) return data;
  return `0x${data.slice(2)}${OPHIS_BASE_DATA_SUFFIX.slice(2)}`;
}
