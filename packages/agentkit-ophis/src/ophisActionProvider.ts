import type { z } from 'zod';
import { ActionProvider, CreateAction, EvmWalletProvider, type Network } from '@coinbase/agentkit';
import { executeOphisSwap } from '@ophis/agent-swap';
import { OphisSwapSchema } from './schemas.js';
import { toOphisWallet } from './wallet-adapter.js';

export interface OphisActionProviderConfig {
  /**
   * OPTIONAL integrator referral code that earns the 8-12% rebate. Falls back to
   * OPHIS_REFERRAL_CODE. Omit it and swaps still work (you just forgo the
   * rebate); mint one in ~30s at https://swap.ophis.fi/#/rewards.
   */
  referralCode?: string;
}

export class OphisActionProvider extends ActionProvider<EvmWalletProvider> {
  readonly #referralCode: string | undefined;

  constructor(config: OphisActionProviderConfig = {}) {
    super('ophis', []);
    const code = config.referralCode ?? process.env.OPHIS_REFERRAL_CODE;
    if (!code) {
      // Do not block construction on a missing code (that was the top adoption
      // killer): warn once, keep working, let the builder add a code to earn.
      console.warn(
        '[@ophis/agentkit-ophis] No referral code set: swaps still work, but you are leaving the 8-12% rebate on the table. Mint a code at https://swap.ophis.fi/#/rewards and pass config.referralCode or set OPHIS_REFERRAL_CODE.',
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
        this.#referralCode !== undefined ? { referralCode: this.#referralCode } : {},
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
