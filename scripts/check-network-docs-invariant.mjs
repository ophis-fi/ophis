#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const chains = [
  ['Ethereum', 1, 'SupportedChainId.MAINNET'],
  ['Optimism', 10, 'AdditionalTargetChainId.OPTIMISM'],
  ['BNB', 56, 'SupportedChainId.BNB'],
  ['Gnosis', 100, 'SupportedChainId.GNOSIS_CHAIN'],
  ['Unichain', 130, '130 as unknown as SupportedChainId'],
  ['Polygon', 137, 'SupportedChainId.POLYGON'],
  ['Robinhood Chain', 4663, '4663 as unknown as SupportedChainId'],
  ['Base', 8453, 'SupportedChainId.BASE'],
  ['Plasma', 9745, 'SupportedChainId.PLASMA'],
  ['Arbitrum', 42161, 'SupportedChainId.ARBITRUM_ONE'],
  ['Avalanche', 43114, 'SupportedChainId.AVALANCHE'],
  ['Ink', 57073, 'SupportedChainId.INK'],
  ['Linea', 59144, 'SupportedChainId.LINEA'],
];

const sovereign = [
  {
    name: 'Optimism',
    chainId: 10,
    orderbook: 'https://optimism-mainnet.ophis.fi',
    settlement: '0x310784c7FCE12d578dA6f53460777bAc9718B859',
  },
  {
    name: 'Unichain',
    chainId: 130,
    orderbook: 'https://unichain-mainnet.ophis.fi',
    settlement: '0x108A678716e5E1776036eF044CAB7064226F714E',
  },
  {
    name: 'Robinhood Chain',
    chainId: 4663,
    orderbook: 'https://robinhood-mainnet.ophis.fi',
    settlement: '0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD',
  },
];

const sdkConfig = read('packages/sdk/src/config.ts');
const sdkDomain = read('packages/sdk/src/domain.ts');
const sdkOrderbook = read('packages/sdk/src/orderbook.ts');
const chainInfo = read('apps/frontend/libs/common-const/src/chainInfo.ts');
const gettingStarted = read('apps/docs-ophis/docs/getting-started.md');
const agentPolicies = read('apps/docs-ophis/docs/agent-wallet-policies.md');
const faq = read('apps/docs-ophis/docs/faq.mdx');

for (const [name, chainId, configKey] of chains) {
  assert.ok(
    `${sdkConfig}\n${chainInfo}`.includes(configKey),
    `${name} (${chainId}) is missing from canonical application chain configuration`,
  );
  assert.match(
    `${gettingStarted}\n${faq}`,
    new RegExp(name.replace('Robinhood Chain', 'Robinhood Chain')),
    `${name} is missing from public supported-chain documentation`,
  );
}

assert.match(faq, /13 EVM chains/, 'FAQ must state the canonical 13-EVM-chain count');
assert.match(
  gettingStarted,
  /Robinhood Chain, and Unichain/,
  'getting-started chain list is incomplete',
);

for (const chain of sovereign) {
  assert.match(
    sdkOrderbook,
    new RegExp(chain.orderbook.replaceAll('.', '\\.')),
    `${chain.name} orderbook drift`,
  );
  assert.ok(
    sdkDomain.includes(chain.settlement),
    `${chain.name} settlement is missing from @ophis/sdk`,
  );
  assert.ok(
    agentPolicies.includes(chain.settlement),
    `${chain.name} settlement drifted in wallet-policy docs`,
  );
  assert.match(
    `${gettingStarted}\n${faq}`,
    new RegExp(`Optimism, Unichain, and Robinhood Chain`),
    'public docs must identify all three Ophis-operated chains together',
  );
}

const robinhoodConstants = read('apps/frontend/libs/common-const/src/robinhood.const.ts');
assert.match(
  robinhoodConstants,
  /https:\/\/docs\.robinhood\.com\/chain\//,
  'Robinhood docs URL must be current',
);
assert.doesNotMatch(
  `${chainInfo}\n${robinhoodConstants}`,
  /docs\.robinhood\.com\/crypto\/robinhood-chain/,
  'removed Robinhood docs URL reappeared',
);

console.log('Network/docs invariants are in sync (13 EVM chains; 3 Ophis-operated chains).');
