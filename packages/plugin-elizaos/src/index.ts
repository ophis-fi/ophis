import type { Plugin } from '@elizaos/core';
import { ophisSwapAction } from './actions/swap.js';

/**
 * elizaOS plugin: Intent-based same-chain swaps via Ophis.
 *
 * The agent signs orders with its OWN EVM key (EIP-712), so there is no managed-
 * wallet dependency. Each order carries the Ophis partner fee in appData; set
 * OPHIS_REFERRAL_CODE for campaign-dependent attribution. Reuses the shared `@ophis/agent-swap`
 * core, so approve + sign + submit (and OP/Robinhood non-canonical addresses) are
 * handled for you.
 *
 * Settings (via character settings / env): EVM_PRIVATE_KEY (required),
 * OPHIS_REFERRAL_CODE, OPHIS_FEE_CHAIN, ETHEREUM_PROVIDER_<CHAIN> (RPC overrides).
 */
export const ophisPlugin: Plugin = {
  name: 'ophis',
  description:
    'Intent-based same-chain token swaps for elizaOS agents, routed through Ophis. The agent signs orders with its own EVM key; orders carry the Ophis partner fee and optional referral attribution.',
  actions: [ophisSwapAction],
};

export default ophisPlugin;
export { ophisSwapAction };
