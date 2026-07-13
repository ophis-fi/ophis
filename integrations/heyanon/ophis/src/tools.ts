import { AdapterExport, EVM } from '@heyanon/sdk';
import { supportedChains } from './constants';

const { getChainName } = EVM.utils;

export const tools: AdapterExport['tools'] = [
  {
    type: 'function',
    function: {
      name: 'ophisSwap',
      description:
        'Swap one ERC-20 for another on the SAME chain via Ophis (CoW Protocol): MEV-protected, gasless, surplus returned to the trader. The wallet signs a GPv2 order with EIP-712. Native ETH is not supported (use WETH). Not for cross-chain bridging.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          chainName: { type: 'string', enum: supportedChains.map(getChainName), description: 'Chain to swap on' },
          sellToken: { type: 'string', description: 'ERC-20 sell token contract address (0x…)' },
          buyToken: { type: 'string', description: 'ERC-20 buy token contract address (0x…)' },
          sellAmount: { type: 'string', description: 'Amount of sellToken in WHOLE units, e.g. "1.5"' },
          slippageBps: { type: ['number', 'null'], description: 'Max slippage in basis points (0-5000); null for the 0.5% default' },
          referralCode: { type: ['string', 'null'], description: 'Optional Ophis referral code that carries the rebate attribution; null if none' },
          isStablePair: { type: ['boolean', 'null'], description: 'true only when BOTH tokens are stablecoins, to apply the 1bp stable fee tier; null otherwise' },
        },
        required: ['chainName', 'sellToken', 'buyToken', 'sellAmount', 'slippageBps', 'referralCode', 'isStablePair'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getOphisSupportedChains',
      description: 'List the chains Ophis MEV-protected swaps are available on.',
      strict: true,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
];
