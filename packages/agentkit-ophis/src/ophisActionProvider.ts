import type { z } from 'zod';
import { ActionProvider, CreateAction, EvmWalletProvider, type Network } from '@coinbase/agentkit';
import { executeOphisSwap } from '@ophis/agent-swap';
import { OphisSwapSchema } from './schemas.js';
import { toOphisWallet } from './wallet-adapter.js';

export interface OphisActionProviderConfig {
  /** The integrator referral code that earns the 8-12% rebate. Falls back to OPHIS_REFERRAL_CODE. */
  referralCode?: string;
}

export class OphisActionProvider extends ActionProvider<EvmWalletProvider> {
  readonly #referralCode: string;

  constructor(config: OphisActionProviderConfig = {}) {
    super('ophis', []);
    const code = config.referralCode ?? process.env.OPHIS_REFERRAL_CODE;
    if (!code) {
      throw new Error(
        '@ophis/agentkit-ophis: referral code required (pass config.referralCode or set OPHIS_REFERRAL_CODE) — it carries the rebate.',
      );
    }
    this.#referralCode = code;
  }

  @CreateAction({
    name: 'swap',
    description:
      'Swap one ERC-20 for another via Ophis (a CoW Protocol fork): gasless, MEV-protected, intent-based. ' +
      'Quotes, signs an EIP-712 order pinned to your own wallet, and submits it so the Ophis rebate accrues. ' +
      'sellAmount is in WHOLE units (e.g. "1.5"). Native ETH is NOT supported — use WETH. ' +
      'Returns a JSON string with the order UID and an explorer URL.',
    schema: OphisSwapSchema,
  })
  async swap(walletProvider: EvmWalletProvider, args: z.infer<typeof OphisSwapSchema>): Promise<string> {
    try {
      const result = await executeOphisSwap(
        toOphisWallet(walletProvider),
        {
          sellToken: args.sellToken,
          buyToken: args.buyToken,
          sellAmount: args.sellAmount,
          slippageBps: args.slippageBps ?? undefined,
        },
        { referralCode: this.#referralCode },
      );
      return JSON.stringify({ success: true, ...result });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Ophis swap failed: ${(error as Error).message}` });
    }
  }

  supportsNetwork = (network: Network) => network.protocolFamily === 'evm';
}

/** Create the Ophis AgentKit action provider. Pass your integrator `referralCode` (or set OPHIS_REFERRAL_CODE). */
export const ophisActionProvider = (config?: OphisActionProviderConfig) => new OphisActionProvider(config);
