import { EVM, EvmChain, FunctionOptions, FunctionReturn, toResult } from '@heyanon/sdk';
import { executeOphisSwap } from '@ophis/agent-swap';
import { supportedChains } from '../constants';
import { toOphisWallet } from '../ophis-wallet';

const { getChainFromName } = EVM.utils;

interface Props {
  chainName: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  slippageBps: number | null;
  // The referral code is a caller-visible arg here: HeyAnon adapters have no deploy-time
  // config channel, so the integrator pins/constrains it in their agent config. It only
  // controls rebate ATTRIBUTION (rides in appData) — not user funds; receiver stays owner.
  referralCode: string;
  isStablePair: boolean | null;
}

/**
 * MEV-protected same-chain swap via Ophis (CoW Protocol). The agent's wallet signs a
 * GPv2 order with EIP-712, so the order settles gaslessly in a batch auction (surplus
 * returned, no sandwiching). Reuses the audited @ophis/agent-swap core.
 */
export async function ophisSwap(
  { chainName, sellToken, buyToken, sellAmount, slippageBps, referralCode, isStablePair }: Props,
  options: FunctionOptions,
): Promise<FunctionReturn> {
  const { evm, notify } = options;
  if (!evm) return toResult('An EVM wallet is required for Ophis swaps.', true);
  // @ophis/agent-swap requires a referral code (it carries the rebate) and THROWS on an
  // empty one, so reject early with a clean message instead of an opaque core error.
  if (!referralCode?.trim()) {
    return toResult('An Ophis referral code is required — it carries the rebate attribution.', true);
  }
  // Ophis/CoW orders are EIP-712-signed. This HeyAnon runtime must expose typed-data
  // signing (optional in the SDK). If absent, a presign build would be needed.
  if (typeof evm.signTypedDatas !== 'function') {
    return toResult('This runtime does not expose EIP-712 typed-data signing, which Ophis (CoW) orders require.', true);
  }

  try {
    // getChainFromName THROWS (does not return falsy) on an unknown name, so it must
    // live inside the try — the strict tool enum should prevent it, but never trust that.
    const chainId = getChainFromName(chainName as EvmChain);
    if (!chainId || !supportedChains.includes(chainId)) {
      return toResult(`Ophis is not available on "${chainName}". Supported: ${supportedChains.join(', ')}.`, true);
    }

    const account = await evm.getAddress();
    await notify?.(`Building an MEV-protected Ophis swap on ${chainName}…`);
    const wallet = toOphisWallet(evm, account, chainId);
    const result = await executeOphisSwap(
      wallet,
      { sellToken, buyToken, sellAmount, slippageBps: slippageBps ?? undefined },
      // isStablePair true drops stablecoin<>stablecoin to the 1bp fee tier (else 5bps).
      { referralCode, isStablePair: isStablePair ?? undefined },
    );
    // Surface a rebate-enrollment warning if the swap submitted but enrollment failed — the order
    // still settles, but the rebate may not index until the wallet is enrolled, so don't hide it.
    const warning = result.enrollmentWarning ? ` Note: ${result.enrollmentWarning}` : '';
    return toResult(
      `MEV-protected Ophis swap submitted on ${chainName}. Order ${result.orderUid} — track it at ${result.explorerUrl}. Solvers settle it in the next CoW batch auction.${warning}`,
    );
  } catch (error) {
    return toResult(`Ophis swap failed: ${(error as Error).message}`, true);
  }
}
