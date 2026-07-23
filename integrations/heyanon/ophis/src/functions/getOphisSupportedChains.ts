import { EVM, FunctionOptions, FunctionReturn, toResult } from '@heyanon/sdk';
import { supportedChains } from '../constants';

const { getChainName } = EVM.utils;

/** Read-only: which chains Ophis MEV-protected swaps are available on. */
export async function getOphisSupportedChains(
  _props: Record<string, never>,
  _options: FunctionOptions,
): Promise<FunctionReturn> {
  const names = supportedChains.map(getChainName).join(', ');
  return toResult(
    `Ophis (CoW Protocol) MEV-protected same-chain swaps are available on: ${names}. ` +
      `Optimism is Ophis-sovereign (100% of price improvement returned); the rest settle via CoW's hosted solvers. Same-chain only — no bridging.`,
  );
}
