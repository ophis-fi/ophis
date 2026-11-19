import { PluginBase, Tool, type Chain } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { arbitrum, avalanche, base, gnosis, mainnet, optimism, polygon } from 'viem/chains';
import { executeOphisSwap, type OphisSwapResult } from '@ophis/agent-swap';
import { OphisSwapParameters } from './parameters.js';
import { isOphisStablePair } from './stablecoins.js';
import { toOphisWallet } from './wallet-adapter.js';

export interface OphisPluginOptions {
  /**
   * OPTIONAL integrator referral code for campaign-dependent attribution (rides in the
   * order's appData). Omit it and swaps still work without referral attribution.
   * Register at https://swap.ophis.fi/#/affiliate.
   */
  referralCode?: string;
}

// Ophis-operated EVM chains with a live orderbook. The swap core re-checks isOphisFeeChain and
// throws on an unsupported chain, so this is the discovery hint, not the hard gate.
const SUPPORTED_CHAINS = [mainnet, gnosis, arbitrum, base, optimism, polygon, avalanche];

class OphisService {
  constructor(private readonly options: OphisPluginOptions) {}

  @Tool({
    name: 'ophis_swap',
    description:
      'Swap one ERC-20 for another via Ophis: intent-based batch settlement. ' +
      'The order carries Ophis appData for optional referral attribution. sellAmount is in WHOLE units ' +
      '(e.g. "1.5"). Native ETH is NOT supported — use WETH. Returns the order UID and an explorer URL.',
  })
  async ophisSwap(walletClient: EVMWalletClient, parameters: OphisSwapParameters): Promise<OphisSwapResult> {
    const wallet = toOphisWallet(walletClient);
    const chainId = wallet.getChainId();
    // Derive the 1bp stable-pair tier from a verified stablecoin list (never caller input),
    // so a stablecoin<>stablecoin swap is charged the reduced rate automatically.
    const isStablePair = isOphisStablePair(chainId, parameters.sellToken, parameters.buyToken);
    return executeOphisSwap(
      wallet,
      {
        sellToken: parameters.sellToken,
        buyToken: parameters.buyToken,
        sellAmount: parameters.sellAmount,
        slippageBps: parameters.slippageBps,
      },
      {
        ...(this.options.referralCode !== undefined ? { referralCode: this.options.referralCode } : {}),
        isStablePair,
      },
    );
  }
}

export class OphisPlugin extends PluginBase<EVMWalletClient> {
  constructor(options: OphisPluginOptions = {}) {
    if (!options?.referralCode) {
      // Do not block construction on a missing code (that was the top adoption
      // killer): warn once, keep working, let the builder add a code to earn.
      console.warn(
        '[@ophis/plugin-goat] No referralCode set: swaps still work without referral attribution. Rewards depend on the active campaign. Register a code at https://swap.ophis.fi/#/affiliate and pass it as options.referralCode.',
      );
    }
    super('ophis', [new OphisService(options)]);
  }

  supportsChain = (chain: Chain) => chain.type === 'evm' && SUPPORTED_CHAINS.some((c) => c.id === chain.id);
}

/** Create the Ophis GOAT plugin. Pass your integrator `referralCode`. */
export const ophis = (options: OphisPluginOptions) => new OphisPlugin(options);
