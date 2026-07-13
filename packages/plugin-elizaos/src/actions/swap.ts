import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  ModelType,
  composePromptFromState,
  parseKeyValueXml,
} from '@elizaos/core';
import { executeOphisSwap } from '@ophis/agent-swap';
import { buildOphisWallet } from '../wallet.js';
import { resolveChain, SUPPORTED_CHAIN_NAMES } from '../chains.js';
import { resolveToken } from '../tokens.js';
import { swapTemplate } from '../templates.js';

export const ophisSwapAction: Action = {
  name: 'OPHIS_SWAP',
  description:
    'Swap one ERC-20 for another on the SAME chain via Ophis (CoW Protocol): MEV-protected, gasless (solvers pay gas), surplus returned to the trader. Native ETH is not supported — use WETH. Not for cross-chain bridging.',
  similes: ['SWAP_TOKENS', 'TOKEN_SWAP', 'EXCHANGE_TOKENS', 'TRADE_TOKENS', 'MEV_PROTECTED_SWAP'],
  // `template` is an allowed extra field on Action ([key: string]: unknown).
  template: swapTemplate,

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const pk = runtime.getSetting('EVM_PRIVATE_KEY');
    return typeof pk === 'string' && /^0x[0-9a-fA-F]{64}$/.test(pk);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      // 1. Extract the swap intent (elizaOS v1 XML pattern).
      const state = await runtime.composeState(message, ['RECENT_MESSAGES']);
      (state as Record<string, unknown>).supportedChains = SUPPORTED_CHAIN_NAMES.join(' | ');
      const prompt = composePromptFromState({ state, template: swapTemplate });
      const xml = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const parsed = parseKeyValueXml(xml);
      if (!parsed) throw new Error('Could not understand the swap request.');

      // 2. Resolve the chain. Require it explicitly (from the request, or an
      // operator-set OPHIS_FEE_CHAIN default) — NEVER silently hardcode one. An
      // unattended agent must not trade on a chain the user never named.
      const defaultChain = runtime.getSetting('OPHIS_FEE_CHAIN');
      const chainRaw =
        String(parsed.chain ?? '').trim() ||
        (typeof defaultChain === 'string' ? defaultChain.trim() : '');
      if (!chainRaw) {
        throw new Error(
          `Which chain? Name one (${SUPPORTED_CHAIN_NAMES.join(', ')}) or set OPHIS_FEE_CHAIN as the default.`,
        );
      }
      const chainName = chainRaw.toLowerCase();
      const resolved = resolveChain(chainName);
      if (!resolved) {
        throw new Error(`Unsupported chain "${chainName}". Ophis supports: ${SUPPORTED_CHAIN_NAMES.join(', ')}.`);
      }

      // 3. Resolve tokens to checksummed addresses (never guess — ask for the address).
      const sellToken = resolveToken(String(parsed.inputToken ?? ''), resolved.id);
      const buyToken = resolveToken(String(parsed.outputToken ?? ''), resolved.id);
      const amount = String(parsed.amount ?? '').trim();
      if (!sellToken) {
        throw new Error(`Unknown sell token on ${chainName}. Provide its 0x contract address.`);
      }
      if (!buyToken) {
        throw new Error(`Unknown buy token on ${chainName}. Provide its 0x contract address.`);
      }
      // Strict plain-decimal check at the boundary (Number('1,000')/'1.5 ETH' are NaN,
      // which the loose `<= 0` guard would let slip through to a viem parse error).
      if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
        throw new Error('Missing or invalid swap amount — use a plain decimal like "1.5".');
      }

      // 4. Execute via the audited Ophis swap core (quote -> appData -> approve ->
      // EIP-712 sign -> submit; OP/Unichain non-canonical addresses handled inside).
      // Trim the referral (env vars often carry a trailing newline) and validate the
      // grammar; an invalid code is DROPPED with a warning rather than blocking the
      // swap — the core is designed never to block on the referral.
      const referralRaw = runtime.getSetting('OPHIS_REFERRAL_CODE');
      let referralCode: string | undefined;
      if (typeof referralRaw === 'string' && referralRaw.trim()) {
        const code = referralRaw.trim().toLowerCase();
        if (/^[a-z0-9_-]{3,64}$/.test(code)) {
          referralCode = code;
        } else {
          console.warn(
            `[@ophis/plugin-elizaos] Ignoring invalid OPHIS_REFERRAL_CODE "${referralRaw}"; swapping without the rebate.`,
          );
        }
      }

      const wallet = buildOphisWallet(runtime, chainName);
      const result = await executeOphisSwap(
        wallet,
        { sellToken, buyToken, sellAmount: amount },
        referralCode ? { referralCode } : {},
      );

      const text = `Submitted an MEV-protected swap on ${chainName} via Ophis. Order ${result.orderUid} — track it at ${result.explorerUrl}`;
      callback?.({ text, content: { success: true, ...result } });
      return { success: true, text, data: { actionName: 'OPHIS_SWAP', ...result } };
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      callback?.({ text: `The Ophis swap could not be completed: ${messageText}`, content: { success: false, error: messageText } });
      return { success: false, text: `Ophis swap failed: ${messageText}`, error: err instanceof Error ? err : new Error(messageText) };
    }
  },

  examples: [
    [
      { name: '{{user}}', content: { text: 'Swap 100 USDC for WETH on Base via Ophis' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Submitting an MEV-protected swap of 100 USDC → WETH on Base through Ophis…',
          action: 'OPHIS_SWAP',
        },
      },
    ],
    [
      { name: '{{user}}', content: { text: 'Sell 0.5 WETH for USDC on Unichain' } },
      {
        name: '{{agent}}',
        content: { text: 'Routing 0.5 WETH → USDC on Unichain via Ophis (MEV-protected)…', action: 'OPHIS_SWAP' },
      },
    ],
  ],
};
