import { isOphisStablePair } from '@ophis/sdk';

/**
 * Classifies fee policy from the server-owned registry. A caller-provided value
 * is only an assertion: reject it when it disagrees so a volatile pair cannot
 * opt into the reduced stable policy and stale clients fail visibly.
 */
export function resolveStablePair(
  chainId: number,
  sellToken: string,
  buyToken: string,
  asserted?: boolean,
): boolean {
  const classified = isOphisStablePair(chainId, sellToken, buyToken);
  if (asserted !== undefined && asserted !== classified) {
    throw new Error(
      `isStablePair=${asserted} disagrees with the Ophis stablecoin registry for chain ${chainId}`,
    );
  }
  return classified;
}
