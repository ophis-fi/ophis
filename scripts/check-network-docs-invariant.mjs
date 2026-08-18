#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(read(path));

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

const selectorEntries = [
  'SupportedChainId.MAINNET',
  'SupportedChainId.BNB',
  'SupportedChainId.BASE',
  'SupportedChainId.ARBITRUM_ONE',
  'SupportedChainId.POLYGON',
  'SupportedChainId.AVALANCHE',
  'SupportedChainId.LINEA',
  'SupportedChainId.PLASMA',
  'SupportedChainId.INK',
  'SupportedChainId.GNOSIS_CHAIN',
  'AdditionalTargetChainId.OPTIMISM as unknown as SupportedChainId',
  '130 as unknown as SupportedChainId',
  '4663 as unknown as SupportedChainId',
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
const aiAgents = read('apps/docs-ophis/docs/ai-agents.md');
const mcpPackage = readJson('apps/mcp-server/package.json');
const sdkPackage = readJson('packages/sdk/package.json');
const agentSkillsPackage = readJson('packages/agent-skills/package.json');
const adapterPackages = [
  readJson('packages/agent-swap/package.json'),
  readJson('packages/agentkit-ophis/package.json'),
  readJson('packages/plugin-goat/package.json'),
  readJson('packages/plugin-elizaos/package.json'),
];

const selectorMatch = chainInfo.match(/export const SORTED_CHAIN_IDS:[^=]+=\s*\[([\s\S]*?)\n\]/);
assert.ok(selectorMatch, 'could not parse canonical SORTED_CHAIN_IDS');
const selectorIds = selectorMatch[1]
  .split('\n')
  .map((line) =>
    line
      .replace(/\/\/.*$/, '')
      .trim()
      .replace(/,$/, ''),
  )
  .filter(Boolean);
assert.deepEqual(
  selectorIds,
  selectorEntries,
  `network selector must expose exactly ${selectorEntries.length} canonical EVM chains`,
);

for (const [name, chainId, configKey] of chains) {
  assert.ok(
    `${sdkConfig}\n${chainInfo}`.includes(configKey),
    `${name} (${chainId}) is missing from canonical application chain configuration`,
  );
  assert.ok(
    `${gettingStarted}\n${faq}`.includes(name),
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
  assert.ok(sdkOrderbook.includes(chain.orderbook), `${chain.name} orderbook drift`);
  assert.ok(
    sdkDomain.includes(chain.settlement),
    `${chain.name} settlement is missing from @ophis/sdk`,
  );
  assert.ok(
    agentPolicies.includes(chain.settlement),
    `${chain.name} settlement drifted in wallet-policy docs`,
  );
  assert.ok(
    `${gettingStarted}\n${faq}\n${aiAgents}`.includes('Optimism, Unichain, and Robinhood Chain'),
    'public docs must identify all three Ophis-operated chains together',
  );
}

const adapterVersions = new Set(adapterPackages.map(({ version }) => version));
assert.equal(adapterVersions.size, 1, 'the four npm adapters must share one release version');
const adapterVersion = adapterPackages[0].version;
const documentedAdapterVersions = aiAgents.split('\n').flatMap((line) => {
  const row = line.match(
    /^\| \[`(@ophis\/[^`]+)`\]\(https:\/\/www\.npmjs\.com\/package\/\1\)\s*\| v(\d+\.\d+\.\d+)\s*\|/,
  );
  return row ? [{ name: row[1], version: row[2] }] : [];
});

assert.equal(
  documentedAdapterVersions.length,
  adapterPackages.length,
  'AI-agent docs must contain exactly one versioned table row for every npm adapter',
);
for (const adapterPackage of adapterPackages) {
  const documentedRows = documentedAdapterVersions.filter(
    ({ name }) => name === adapterPackage.name,
  );
  assert.equal(
    documentedRows.length,
    1,
    `AI-agent docs must contain exactly one table row for ${adapterPackage.name}`,
  );
  assert.equal(
    documentedRows[0].version,
    adapterPackage.version,
    `AI-agent docs table version for ${adapterPackage.name} drifted from its manifest`,
  );
}

assert.ok(
  aiAgents.includes(`current server release is **v${mcpPackage.version}**`),
  'AI-agent docs MCP version drifted from its package',
);
assert.ok(
  aiAgents.includes(`published on npm (v${sdkPackage.version}, public)`),
  'AI-agent docs SDK version drifted from its package',
);
assert.ok(
  aiAgents.includes(`The v${adapterVersion} adapter family`),
  'AI-agent docs adapter version drifted from its packages',
);
assert.ok(
  aiAgents.includes(`v${agentSkillsPackage.version} for runtimes`),
  'AI-agent docs agent-skills version drifted from its package',
);
assert.match(
  aiAgents,
  /SWAP_APP = "https:\/\/swap\.ophis\.fi"[\s\S]*return f"\{SWAP_APP\}\/\#\//,
  'AI-agent Python helper must build deep links on swap.ophis.fi',
);
assert.doesNotMatch(
  aiAgents,
  /return f"\{OPHIS\}\/\#\//,
  'AI-agent Python helper must not build deep links on the API origin',
);
assert.ok(
  aiAgents.includes('receiver unconditionally pinned to the owner'),
  'AI-agent MCP docs must describe build_order receiver pinning as unconditional',
);
assert.match(
  aiAgents,
  /50% capped at 20 bps for stable pairs, versus 80%[\s\S]*capped at 99 bps for volatile pairs/,
  'AI-agent docs fee policy drifted from the current stable/volatile improvement caps',
);

const robinhoodConstants = read('apps/frontend/libs/common-const/src/robinhood.const.ts');
assert.ok(
  robinhoodConstants.includes("'https://docs.robinhood.com/chain/'"),
  'Robinhood docs URL must be current',
);
assert.ok(
  !`${chainInfo}\n${robinhoodConstants}`.includes('docs.robinhood.com/crypto/robinhood-chain'),
  'removed Robinhood docs URL reappeared',
);

console.log('Network/docs invariants are in sync (13 EVM chains; 3 Ophis-operated chains).');
