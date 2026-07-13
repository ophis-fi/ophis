import type { Plugin } from '@elizaos/core';
import { ophisSwapAction } from './actions/swap.js';

/**
 * elizaOS plugin: MEV-protected same-chain swaps via Ophis (CoW Protocol).
 *
 * The agent signs CoW orders with its OWN EVM key (EIP-712), so there is no managed-
 * wallet dependency. Each order carries the Ophis partner fee in appData; set
 * OPHIS_REFERRAL_CODE to earn the 8-12% rebate. Reuses the audited `@ophis/agent-swap`
 * core, so approve + sign + submit (and OP/Unichain non-canonical addresses) are
 * handled for you.
 *
 * Settings (via character settings / env): EVM_PRIVATE_KEY (required),
 * OPHIS_REFERRAL_CODE, OPHIS_FEE_CHAIN, ETHEREUM_PROVIDER_<CHAIN> (RPC overrides).
 */
export const ophisPlugin: Plugin = {
  name: 'ophis',
  description:
    'MEV-protected same-chain token swaps for elizaOS agents, routed through Ophis (CoW Protocol). The agent signs CoW orders with its own EVM key; the Ophis partner fee + your referral code accrue the rebate.',
  actions: [ophisSwapAction],
};

export default ophisPlugin;
export { ophisSwapAction };
