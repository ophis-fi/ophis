import { AdapterExport, AdapterTag, Chain, EVM } from '@heyanon/sdk';
import { supportedChains } from './constants';
import * as functions from './functions';
import { tools } from './tools';

const { getChainName } = EVM.utils;

// Explicit AdapterExport annotation (not `satisfies`): the inferred default-export type would
// otherwise reference a transitive @heyanon/sdk type via a non-portable .pnpm/openai path
// (TS2742) when the project is built inside a pnpm workspace (e.g. anon-integration-guide).
const adapter: AdapterExport = {
  tools,
  functions,
  description:
    'Ophis: MEV-protected same-chain token swaps on CoW Protocol. Swaps settle in a batch auction (uniform clearing price, surplus returned to the trader, no sandwiching) and are gasless — the wallet signs an EIP-712 order and solvers pay settlement gas. Carries an integrator partner fee. ophisSwap: execute a swap; getOphisSupportedChains: list supported chains.',
  tags: [AdapterTag.DEX],
  chains: supportedChains.map(getChainName) as Chain[],
  executableFunctions: ['ophisSwap'],
};

export default adapter;
