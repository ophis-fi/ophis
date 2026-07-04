#!/usr/bin/env node
// Ophis - agent-wallet policy-pack address drift check.
//
// The Turnkey and Privy policy packs in examples/agent-wallet-policy-packs/
// pin an agent key to Ophis settlement + relayer contracts per chain. Those
// addresses live in a hand-maintained table (addresses.json) that MUST stay
// byte-identical to the authoritative maps in the SDK. If a chain is added or
// an address rotated in the SDK but not in the pack (or vice versa), a pack
// would authorize the wrong contract, the exact silent-drift class the
// partner-fee / floor invariant checks already guard for their own literals.
//
// This script is the hard gate:
//   Gate A: addresses.json <-> @ophis/sdk domain.ts, exact + case-sensitive,
//            for every one of the 12 live chains (and asserts the paused /
//            testnet chains 4326 / 999 / 11155111 stay OUT of the packs).
//   Gate B: every unique settlement + relayer literal in addresses.json is
//            present verbatim in the docs page and the pack README, so the
//            copy-paste collateral cannot drift from the checked table.
//
// Pure Node, no build step and no deps (mirrors scripts/*.mjs and the bash
// invariant checks). Run from the repo root. Exit 0 = OK, 1 = drift.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(REPO_ROOT, p);

const SDK_DOMAIN = 'packages/sdk/src/domain.ts';
const TABLE = 'examples/agent-wallet-policy-packs/addresses.json';
const PRESENCE_FILES = [
  'apps/docs-ophis/docs/agent-wallet-policies.md',
  'examples/agent-wallet-policy-packs/README.md',
];

// The 12 live chains the packs cover. Kept here so a chain silently dropped
// from either the SDK or the table is caught (not just a value mismatch).
const EXPECTED_CHAIN_IDS = [1, 10, 56, 100, 130, 137, 8453, 9745, 42161, 43114, 57073, 59144];
// Deployed-but-paused (4326, 999) and testnet (11155111): MUST NOT appear in
// the packs. The docs claim the packs cover only the live chains.
const FORBIDDEN_CHAIN_IDS = [4326, 999, 11155111];

const errors = [];
const fail = (m) => errors.push(m);

/**
 * Parse a `Readonly<...> = Object.freeze({ ... })` address map out of the SDK
 * domain.ts, resolving the named `const NAME = '0x..'` constants the map
 * references. Returns { [chainId]: '0xEIP55Address' }.
 */
function parseSdkMap(src, mapName) {
  // 1. Resolve every `const NAME = '0x....' as const;` to its literal.
  const consts = {};
  for (const m of src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*'(0x[0-9a-fA-F]{40})'\s*as const;/g)) {
    consts[m[1]] = m[2];
  }
  // 2. Grab the Object.freeze({ ... }) body for the named export.
  const re = new RegExp(`export const ${mapName}[^=]*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`);
  const body = src.match(re);
  if (!body) {
    fail(`could not locate ${mapName} in ${SDK_DOMAIN}`);
    return {};
  }
  // 3. Parse `NUM: TOKEN,` where TOKEN is a const name or a 0x literal.
  const out = {};
  for (const line of body[1].split('\n')) {
    const entry = line.match(/^\s*(\d+):\s*([A-Za-z0-9_']+)/);
    if (!entry) continue;
    const chainId = Number(entry[1]);
    let token = entry[2];
    let addr;
    if (token.startsWith("'")) {
      addr = token.replace(/'/g, '');
    } else if (consts[token] !== undefined) {
      addr = consts[token];
    } else {
      fail(`${mapName}[${chainId}] references unknown constant "${token}"`);
      continue;
    }
    out[chainId] = addr;
  }
  return out;
}

const sdkSrc = readFileSync(rel(SDK_DOMAIN), 'utf8');
const sdkSettlement = parseSdkMap(sdkSrc, 'OPHIS_SETTLEMENT_ADDRESSES');
const sdkRelayer = parseSdkMap(sdkSrc, 'OPHIS_VAULT_RELAYER_ADDRESSES');

// SDK-completeness: any chain the SDK maps that is not paused/testnet is a LIVE
// chain the packs must cover. If the SDK adds one but EXPECTED_CHAIN_IDS (and
// thus the per-chain checks below) does not know about it, catch it here rather
// than passing silently, which is the exact SDK-only drift this gate must block.
const sdkLiveChains = [...new Set([...Object.keys(sdkSettlement), ...Object.keys(sdkRelayer)].map(Number))].filter(
  (id) => !FORBIDDEN_CHAIN_IDS.includes(id),
);
for (const id of sdkLiveChains) {
  if (!EXPECTED_CHAIN_IDS.includes(id)) {
    fail(
      `SDK maps live chain ${id} but the pack check does not cover it. If chain ${id} went live, add it to ` +
        `addresses.json, the collateral, and EXPECTED_CHAIN_IDS in the SAME PR.`,
    );
  }
}

const table = JSON.parse(readFileSync(rel(TABLE), 'utf8'));

// --- Gate A: table <-> SDK -------------------------------------------------
const tableById = new Map(table.chains.map((c) => [c.chainId, c]));

// Domain name/version must be the CoW/Gnosis Protocol literals the SDK signs.
if (table.domain?.name !== 'Gnosis Protocol' || table.domain?.version !== 'v2') {
  fail(`table domain is ${JSON.stringify(table.domain)}; expected { name: "Gnosis Protocol", version: "v2" }`);
}

for (const chainId of EXPECTED_CHAIN_IDS) {
  const row = tableById.get(chainId);
  if (!row) {
    fail(`table is missing live chain ${chainId}`);
    continue;
  }
  const wantSettlement = sdkSettlement[chainId];
  const wantRelayer = sdkRelayer[chainId];
  if (!wantSettlement) fail(`SDK has no settlement for chain ${chainId} (SDK dropped a live chain?)`);
  else if (row.settlement !== wantSettlement) {
    fail(`chain ${chainId} settlement drift: table ${row.settlement} != SDK ${wantSettlement}`);
  }
  if (!wantRelayer) fail(`SDK has no relayer for chain ${chainId} (SDK dropped a live chain?)`);
  else if (row.relayer !== wantRelayer) {
    fail(`chain ${chainId} relayer drift: table ${row.relayer} != SDK ${wantRelayer}`);
  }
  // sovereign flag must match reality: a sovereign chain does NOT use the
  // canonical settlement (that is the whole Ophis-exclusive-domain caveat).
  const isCanonical = wantSettlement === table.canonical?.settlement;
  if (row.sovereign === isCanonical) {
    fail(`chain ${chainId} sovereign flag is ${row.sovereign} but settlement ${row.settlement} ` +
      `${isCanonical ? 'IS' : 'is NOT'} the canonical address`);
  }
}

// No extra chains, and none of the forbidden (paused/testnet) ones.
for (const c of table.chains) {
  if (!EXPECTED_CHAIN_IDS.includes(c.chainId)) {
    fail(`table lists unexpected chain ${c.chainId} (${c.name}); update EXPECTED_CHAIN_IDS if this chain went live`);
  }
  if (FORBIDDEN_CHAIN_IDS.includes(c.chainId)) {
    fail(`table lists paused/testnet chain ${c.chainId}; the packs must cover live chains only`);
  }
}

// --- Gate B: literals present in the copy-paste collateral ------------------
const uniqueAddresses = [
  ...new Set(table.chains.flatMap((c) => [c.settlement, c.relayer])),
];
for (const f of PRESENCE_FILES) {
  let content;
  try {
    content = readFileSync(rel(f), 'utf8');
  } catch {
    fail(`presence-check file missing: ${f}`);
    continue;
  }
  for (const addr of uniqueAddresses) {
    if (!content.includes(addr)) {
      fail(`${f} is missing address literal ${addr} (collateral drifted from addresses.json)`);
    }
  }
}

// --- Gate C: per-CHAIN rows in the copy-paste table map to the CORRECT --------
// address. Gate B only proves each address appears SOMEWHERE, so a row that pairs
// the right chain with the WRONG (but valid, allowlisted-elsewhere) address would
// pass B. Integrators paste per-chain, so a mis-paired row is the real hazard.
// Parse the markdown table rows `| name | id | `settlement` | `relayer` |` and
// verify each against addresses.json (which Gate A pins to the SDK).
const ROW_RE = /^\|[^|]*\|\s*(\d+)\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|\s*`(0x[0-9a-fA-F]{40})`\s*\|/;
for (const f of PRESENCE_FILES) {
  let content;
  try {
    content = readFileSync(rel(f), 'utf8');
  } catch {
    continue; // already reported by Gate B
  }
  for (const line of content.split('\n')) {
    const m = line.match(ROW_RE);
    if (!m) continue;
    const chainId = Number(m[1]);
    const [, , settlement, relayer] = m;
    const row = tableById.get(chainId);
    if (!row) {
      fail(`${f} copy-paste table lists chain ${chainId} which is not in addresses.json`);
      continue;
    }
    if (settlement !== row.settlement) {
      fail(`${f} chain ${chainId} settlement in the copy-paste table is ${settlement} but addresses.json says ${row.settlement} (a mis-paired row an integrator would paste)`);
    }
    if (relayer !== row.relayer) {
      fail(`${f} chain ${chainId} relayer in the copy-paste table is ${relayer} but addresses.json says ${row.relayer} (a mis-paired row an integrator would paste)`);
    }
  }
}

// --- Report ----------------------------------------------------------------
if (errors.length > 0) {
  console.error('Policy-pack address check FAILED:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    '\nThe Ophis policy packs pin an agent key to these settlement/relayer\n' +
      'contracts. If you added a chain or rotated an address in the SDK, update\n' +
      `${TABLE} and the copy-paste collateral in the SAME PR, then re-run:\n` +
      '  node scripts/check-policy-pack-addresses.mjs\n',
  );
  process.exit(1);
}

console.log(
  `OK: policy-pack addresses match @ophis/sdk for all ${EXPECTED_CHAIN_IDS.length} live chains ` +
    `(${uniqueAddresses.length} unique settlement/relayer literals, present in collateral).`,
);
process.exit(0);
