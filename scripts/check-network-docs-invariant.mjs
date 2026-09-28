#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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
  ['Arc', 5042, 'arc: 5042'],
  ['Base', 8453, 'SupportedChainId.BASE'],
  ['Plasma', 9745, 'SupportedChainId.PLASMA'],
  ['Arbitrum', 42161, 'SupportedChainId.ARBITRUM_ONE'],
  ['Avalanche', 43114, 'SupportedChainId.AVALANCHE'],
  ['Ink', 57073, 'SupportedChainId.INK'],
  ['Linea', 59144, 'SupportedChainId.LINEA'],
];

const selectorEntries = [
  '...ARC_ENABLED_CHAIN_IDS',
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
  {
    name: 'Arc',
    chainId: 5042,
    orderbook: 'https://arc-mainnet.ophis.fi',
    settlement: '0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A',
  },
];

const sdkConfig = read('packages/sdk/src/config.ts');
const sdkDomain = read('packages/sdk/src/domain.ts');
const sdkOrderbook = read('packages/sdk/src/orderbook.ts');
const sdkFees = read('packages/sdk/src/partner-fee.ts');
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

const feeChainMatch = sdkFees.match(/const FEE_CHAIN_IDS = \[([\s\S]*?)\] as const/);
assert.ok(feeChainMatch, 'could not parse SDK fee-chain coverage used by MCP list_chains');
const feeChainIds = feeChainMatch[1].replace(/\/\/[^\n]*/g, '').match(/\d+/g).map(Number);
const expectedSdkIds = [...chains.map(([, id]) => id), 11155111].sort((a, b) => a - b);
assert.deepEqual(feeChainIds.sort((a, b) => a - b), expectedSdkIds, 'SDK/MCP mainnet coverage drift');
const orderbookIds = [...sdkOrderbook.matchAll(/^  (\d+): 'https:\/\//gm)].map((match) => Number(match[1]));
assert.deepEqual(orderbookIds.sort((a, b) => a - b), expectedSdkIds, 'SDK orderbook coverage drift');

for (const path of [
  'apps/docs-ophis/docs/networks-assets.md',
  'apps/docs-ophis/docs/comparison.md',
  'apps/docs-ophis/docs/agent-swap-comparison.md',
  'apps/docs-ophis/docs/agent-btc-cookbook.md',
  'apps/docs-ophis/docs/faq.mdx',
  'apps/docs-ophis/static/llms.txt',
]) {
  const doc = read(path);
  assert.match(doc, /SDK v0\.4\.3[\s\S]*?14[^.]*including Arc/, `${path}: SDK/MCP coverage must include Arc`);
  assert.doesNotMatch(doc, /(?:exclude|excluding) Arc[.;|\n]/, `${path}: stale SDK/MCP Arc exclusion`);
}
assert.match(aiAgents, /"arc": 5042/, 'Python intent helper must resolve Arc');
const partners = read('apps/docs-ophis/docs/partners.md');
assert.match(partners, /arc-mainnet\.ophis\.fi/, 'partner guide must document the Arc host');
assert.match(partners, /0x78799F98276efba1EdeeD32eae03a3fd8Cdfec3A/, 'partner guide must document the Arc domain');
assert.match(partners, /buildOphisReferrerMetadata\(chainId === 5042 \? undefined : 'your-code', chainId\)/,
  'partner referral example must omit Arc attribution and pass chain context');
assert.doesNotMatch(partners, /Arc is app-only|Arc is app-supported but not yet/, 'stale Arc SDK exclusion in partner guide');

const landingSource = 'apps/frontend/apps/ophis-landing/src/';
const publicSitePaths = [
  ...readdirSync(new URL(`../${landingSource}`, import.meta.url), { recursive: true })
    .filter((path) => /\.(?:astro|md|mdx)$/.test(path))
    .map((path) => `${landingSource}${path}`),
  'apps/frontend/apps/ophis-landing/public/apis.json',
  'apps/frontend/apps/ophis-landing/public/llms.txt',
  'apps/frontend/apps/ophis-landing/public/.well-known/ai-plugin.json',
  'apps/frontend/apps/ophis-landing/public/.well-known/agent-skills/swap-via-ophis/SKILL.md',
  'apps/frontend/apps/cowswap-frontend/public/llms.txt',
  'apps/frontend/apps/cowswap-frontend/public/business/index.html',
  'apps/frontend/apps/cowswap-frontend/index.html',
  'apps/frontend/apps/cowswap-frontend/src/pages/About/index.tsx',
  'apps/frontend/apps/cowswap-frontend/src/ophis/components/OphisFooter.tsx',
  'apps/frontend/apps/explorer/public/llms.txt',
  'apps/frontend/apps/explorer/index.html',
  'apps/mcp-server/README.md',
  'README.md',
];
for (const path of publicSitePaths) {
  const source = read(path);
  // Dated blog posts can quote historical counts, as in the landing count gate.
  if (!path.includes('/src/content/')) {
    assert.doesNotMatch(source, /\b13 (?:supported )?EVM (?:chains|networks)\b|13 mainnets \+ Sepolia/, `${path}: stale network count`);
  }
  assert.doesNotMatch(source,
    /(?:mappings (?:currently )?exclude Arc|supported chains excluding Arc|Arc \(5042\) is not\.|not in the published SDK\/MCP mappings|Arc[^.\n]*?(?:absent from|excluded from|not yet included in) published SDK\/MCP)/,
    `${path}: stale Arc integration exclusion`);
}

assert.match(faq, /14 EVM chains/, 'FAQ must state the canonical 14-EVM-chain count');
if (read('infra/arc-mainnet/release/render.py').includes('[fee-policies]\npolicies = []')) {
  assert.match(
    read('apps/docs-ophis/docs/fees.md'),
    /### Arc release exception/,
    'Arc without configured protocol fees must not inherit the standard improvement claim',
  );
}
assert.match(read('apps/frontend/libs/common-const/src/arc.const.ts'), /ARC_CHAIN_ID = 5042 as SupportedChainId/);
assert.match(gettingStarted, /Arc is available in the swap app \(chain ID 5042\)/);
assert.match(
  gettingStarted,
  /Robinhood Chain, Unichain, and Arc/,
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
    aiAgents.includes(new URL(chain.orderbook).host) && aiAgents.includes(String(chain.chainId)),
    `${chain.name} host and chain ID must be documented for manual integrations`,
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

console.log(`Network/docs invariants are in sync (${chains.length} app and SDK/MCP mainnet chains; Sepolia is separate).`);
