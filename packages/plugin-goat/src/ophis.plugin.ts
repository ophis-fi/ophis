import { PluginBase, Tool, type Chain } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { arbitrum, avalanche, base, gnosis, mainnet, optimism, polygon } from 'viem/chains';
import { executeOphisSwap, type OphisSwapResult } from '@ophis/agent-swap';
import { OphisSwapParameters } from './parameters.js';
import { toOphisWallet } from './wallet-adapter.js';

export interface OphisPluginOptions {
  /** The integrator referral code that earns the 8-12% rebate (rides in the order's appData). */
  referralCode: string;
}

// Ophis-operated EVM chains with a live orderbook. The swap core re-checks isOphisFeeChain and
// throws on an unsupported chain, so this is the discovery hint, not the hard gate.
const SUPPORTED_CHAINS = [mainnet, gnosis, arbitrum, base, optimism, polygon, avalanche];

class OphisService {
  constructor(private readonly options: OphisPluginOptions) {}

  @Tool({
    name: 'ophis_swap',
    description:
      'Swap one ERC-20 for another via Ophis (a CoW Protocol fork): MEV-protected, gasless, intent-based. ' +
      'The order carries Ophis appData so the integrator earns the rebate. sellAmount is in WHOLE units ' +
      '(e.g. "1.5"). Native ETH is NOT supported — use WETH. Returns the CoW order UID and an explorer URL.',
  })
  async ophisSwap(walletClient: EVMWalletClient, parameters: OphisSwapParameters): Promise<OphisSwapResult> {
    return executeOphisSwap(
      toOphisWallet(walletClient),
      {
        sellToken: parameters.sellToken,
        buyToken: parameters.buyToken,
        sellAmount: parameters.sellAmount,
        slippageBps: parameters.slippageBps,
      },
      { referralCode: this.options.referralCode },
    );
  }
}

export class OphisPlugin extends PluginBase<EVMWalletClient> {
  constructor(options: OphisPluginOptions) {
    if (!options?.referralCode) {
      throw new Error('@ophis/plugin-goat: referralCode is required (it carries the rebate).');
    }
    super('ophis', [new OphisService(options)]);
  }

  supportsChain = (chain: Chain) => chain.type === 'evm' && SUPPORTED_CHAINS.some((c) => c.id === chain.id);
}

/** Create the Ophis GOAT plugin. Pass your integrator `referralCode`. */
export const ophis = (options: OphisPluginOptions) => new OphisPlugin(options);
