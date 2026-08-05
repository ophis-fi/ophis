#!/usr/bin/env node
// Ophis - agent-skill family invariant check.
//
// The skill family published at
// apps/frontend/apps/ophis-landing/public/.well-known/agent-skills/ophis/
// tells third-party agents which contracts to approve and sign against, and
// which orderbook hosts to trust. Every one of those literals is a
// hand-maintained copy of an authoritative value elsewhere in the repo, the
// exact silent-drift class the policy-pack / partner-fee / floor gates
// already guard for their surfaces. This script is the hard gate for the
// skills surface:
//
//   Gate A: the umbrella SKILL.md openclaw policy block <-> @ophis/sdk
//           (settlement + relayer maps in domain.ts, orderbook hosts in
//           orderbook.ts), exact + case-sensitive, for every policy chain;
//           spenders must equal the relayer; EIP-712 verifyingContract must
//           equal the settlement; policy chains must be sovereign (non-
//           canonical) Ophis-operated chains. The policy is resolved at its
//           EXACT frontmatter path metadata.openclaw.web3.policy via the
//           fail-closed tree parser in scripts/lib/frontmatter.mjs: a block
//           moved anywhere else fails, because that path is what
//           policy-enforcing agent runtimes resolve.
//   Gate B: every 0x address literal anywhere in the family is on an explicit
//           allowlist (policy addresses, fee recipient, documented example
//           tokens), so a typo'd or model-hallucinated address cannot ship.
//   Gate C: the cancellation skill pins the EIP-712 type strings and type
//           hashes to the backend constants in model/src/order.rs, including
//           the singular-field-vs-plural-JSON trap it documents.
//   Gate D: snippet lint. Read-only skills contain no state-changing or
//           key-touching commands in any fenced code block; execution skills
//           sign keystore-first via SIGNER_ARGS and never grant unlimited
//           approvals; no skill exports a raw private key.
//   Gate E: fee + appData literals (volumeBps, recipient, appData version)
//           match @ophis/sdk partner-fee.ts and the SDK order-build
//           APP_DATA_VERSION (moved out of the MCP server by WP0/#899; the
//           MCP path is kept as a parse fallback).
//   Gate F: the slippage latches in the policy block are present and sane.
//
// Pure Node, no deps (mirrors scripts/check-policy-pack-addresses.mjs; the
// frontmatter tree parser is the in-repo scripts/lib/frontmatter.mjs).
// Run from anywhere. Exit 0 = OK, 1 = drift.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parseSkillFrontmatter } from './lib/frontmatter.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(REPO_ROOT, p);

const SKILLS_DIR = 'apps/frontend/apps/ophis-landing/public/.well-known/agent-skills/ophis';
const UMBRELLA = `${SKILLS_DIR}/SKILL.md`;
const SDK_DOMAIN = 'packages/sdk/src/domain.ts';
const SDK_ORDERBOOK = 'packages/sdk/src/orderbook.ts';
const SDK_PARTNER_FEE = 'packages/sdk/src/partner-fee.ts';
// APP_DATA_VERSION's home moved in WP0 (#899): the order-build core was
// extracted from the MCP server into the SDK, with the MCP file re-exporting.
// The SDK location is authoritative; the MCP path is kept as a fallback so
// this gate survives one more relocation with an exact error, not a
// wrong-path parse.
const SDK_ORDER_BUILD = 'packages/sdk/src/order-build.ts';
const MCP_OPHIS = 'apps/mcp-server/src/ophis.ts';
const MODEL_ORDER_RS = 'apps/backend/crates/model/src/order.rs';

// The chains the skill family's execution policy covers: the Ophis-operated
// (sovereign) chains whose orderbooks Ophis self-hosts. Deliberately narrower
// than the 12-chain policy-pack table: the skills' pinned execution lane is
// the Ophis-run stack only.
const POLICY_CHAIN_IDS = [10, 130, 4663];

// CoW canonical GPv2 addresses. They must NEVER appear in the family: on the
// policy chains they are the wrong contracts (the deployed Ophis stack
// rejects signatures against them / never pulls from them).
const CANONICAL_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const CANONICAL_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

// Non-policy address literals the skill prose is allowed to use, each with a
// reason. Anything else 40-hex is a failure (Gate B).
const EXAMPLE_ADDRESSES = {
  '0x4200000000000000000000000000000000000006': 'WETH on Optimism (documented example token)',
  '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 'USDC native on Optimism (documented example token)',
  '0x0000000000000000000000000000000000000001': 'neutral from-address for indicative quotes',
};

const READ_ONLY_SKILLS = ['ophis-quote.md', 'ophis-order-status.md', 'ophis-surplus-report.md'];
const EXECUTION_SKILLS = ['ophis-swap.md', 'ophis-cancel.md'];

const errors = [];
const fail = (m) => errors.push(m);
const read = (p) => readFileSync(rel(p), 'utf8');

// --- authoritative sources ---------------------------------------------------

/** Same parser as scripts/check-policy-pack-addresses.mjs: resolve the named
 *  consts, then the Object.freeze({...}) body of the given exported map. */
function parseSdkMap(src, mapName) {
  const consts = {};
  for (const m of src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*'(0x[0-9a-fA-F]{40})'\s*as const;/g)) {
    consts[m[1]] = m[2];
  }
  const body = src.match(new RegExp(`export const ${mapName}[^=]*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  if (!body) {
    fail(`could not locate ${mapName} in ${SDK_DOMAIN}`);
    return {};
  }
  const out = {};
  for (const line of body[1].split('\n')) {
    const entry = line.match(/^\s*(\d+):\s*([A-Za-z0-9_']+)/);
    if (!entry) continue;
    const token = entry[2];
    out[Number(entry[1])] = token.startsWith("'") ? token.replace(/'/g, '') : consts[token];
  }
  return out;
}

const sdkDomainSrc = read(SDK_DOMAIN);
const sdkSettlement = parseSdkMap(sdkDomainSrc, 'OPHIS_SETTLEMENT_ADDRESSES');
const sdkRelayer = parseSdkMap(sdkDomainSrc, 'OPHIS_VAULT_RELAYER_ADDRESSES');

const sdkOrderbooks = {};
for (const m of read(SDK_ORDERBOOK).matchAll(/^\s*(\d+):\s*'(https:\/\/[^']+)',/gm)) {
  sdkOrderbooks[Number(m[1])] = m[2];
}

const partnerFeeSrc = read(SDK_PARTNER_FEE);
const sdkFeeRecipient = partnerFeeSrc.match(/OPHIS_PARTNER_FEE_RECIPIENT\s*=\s*\n?\s*'(0x[0-9a-fA-F]{40})'/)?.[1];
const sdkVolumeBps = partnerFeeSrc.match(/export const OPHIS_VOLUME_FEE_BPS = (\d+);/)?.[1];
const sdkStableBps = partnerFeeSrc.match(/export const OPHIS_STABLE_VOLUME_FEE_BPS = (\d+);/)?.[1];
const sdkSovereignBps = partnerFeeSrc.match(/export const OPHIS_SOVEREIGN_VOLUME_FEE_BPS = (\d+);/)?.[1];
if (!sdkFeeRecipient || !sdkVolumeBps || !sdkStableBps || !sdkSovereignBps) {
  fail(`could not parse fee recipient / bps constants from ${SDK_PARTNER_FEE}`);
}

/** Parse a constant from the first location that defines it. Fail-closed with
 *  a per-path report when no location matches (missing file vs present-but-
 *  no-match are named separately, so a future move is an exact message). */
function parseFirst(paths, re, what) {
  const tried = [];
  for (const p of paths) {
    let src;
    try {
      src = read(p);
    } catch {
      tried.push(`${p} (file missing)`);
      continue;
    }
    const m = src.match(re);
    if (m) return m[1];
    tried.push(`${p} (present, pattern not found)`);
  }
  fail(`could not parse ${what} from any known location: ${tried.join('; ')}`);
  return undefined;
}

const appDataVersion = parseFirst(
  [SDK_ORDER_BUILD, MCP_OPHIS],
  /APP_DATA_VERSION = '([0-9.]+)'/,
  'APP_DATA_VERSION',
);

const orderRs = read(MODEL_ORDER_RS);
// The EIP-712 cancellation type strings, keccak-proven against the deployed
// TYPE_HASH constants (verify: `cast keccak '<string>'`):
//   OrderCancellation(bytes orderUid)        -> 0x7b41b3a6...88ec  (single)
//   OrderCancellations(bytes[] orderUids)    -> 0x4c89efb9...588e  (batch, PLURAL field)
//   OrderCancellations(bytes[] orderUid)     -> 0x85d264d5...a600  (WRONG: does not
//     match any deployed constant; a stale doc comment above the batch
//     TYPE_HASH in order.rs claimed it until fixed, which is why the hashes
//     below are extracted from the impl blocks, never from doc comments.)
const CANCEL_SINGLE_TYPE = 'OrderCancellation(bytes orderUid)';
const CANCEL_BATCH_TYPE = 'OrderCancellations(bytes[] orderUids)';
const CANCEL_BATCH_TYPE_WRONG_SINGULAR = 'OrderCancellations(bytes[] orderUid)';
const cancelSingleHash = orderRs.match(
  /impl OrderCancellation \{[\s\S]{0,300}?hex!\("([0-9a-f]{64})"\)/,
)?.[1];
const cancelBatchHash = orderRs.match(
  /impl OrderCancellations \{[\s\S]{0,300}?hex!\("([0-9a-f]{64})"\)/,
)?.[1];
if (!cancelSingleHash || !cancelBatchHash) {
  fail(`could not parse the cancellation type hashes from ${MODEL_ORDER_RS}`);
}
if (cancelSingleHash && !cancelSingleHash.startsWith('7b41b3a6')) {
  fail(`single-cancel TYPE_HASH in ${MODEL_ORDER_RS} is 0x${cancelSingleHash}; expected the keccak of "${CANCEL_SINGLE_TYPE}" (0x7b41b3a6...). Re-verify with cast keccak before updating this gate.`);
}
if (cancelBatchHash && !cancelBatchHash.startsWith('4c89efb9')) {
  fail(`batch-cancel TYPE_HASH in ${MODEL_ORDER_RS} is 0x${cancelBatchHash}; expected the keccak of "${CANCEL_BATCH_TYPE}" (0x4c89efb9...). Re-verify with cast keccak before updating this gate.`);
}
// The enforced batch-cancel cap (cancel_orders_handler checks this constant;
// its error-message text is not authoritative and has lagged it before).
const orderUidLimit = orderRs.match(/pub const ORDER_UID_LIMIT: usize = (\d+);/)?.[1];
if (!orderUidLimit) fail(`could not parse ORDER_UID_LIMIT from ${MODEL_ORDER_RS}`);

// --- the umbrella policy block ----------------------------------------------
// Parsed as a nested tree and resolved at the EXACT path agent runtimes use,
// metadata.openclaw.web3.policy. The previous extraction matched section names
// (`allowedContracts:` etc.) at any indentation anywhere in the frontmatter,
// which kept passing when the whole block was moved to a wrong path (e.g.
// metadata.policy) that runtimes would never resolve.

const umbrella = read(UMBRELLA);
let umbrellaFm = {};
try {
  umbrellaFm = parseSkillFrontmatter(umbrella, UMBRELLA);
} catch (e) {
  fail(e.message);
}
const policy = umbrellaFm?.metadata?.openclaw?.web3?.policy;
const policyIsObject = policy !== null && typeof policy === 'object' && !Array.isArray(policy);
if (!policyIsObject) {
  fail(`${UMBRELLA}: no policy block at the exact frontmatter path metadata.openclaw.web3.policy (moving it breaks policy-enforcing agent runtimes)`);
}
const allowedContracts = (policyIsObject && policy.allowedContracts) || {};
const allowedSpenders = (policyIsObject && policy.allowedSpenders) || {};
const eip712 = (policyIsObject && policy.eip712Domains) || {};
const orderbooks = (policyIsObject && policy.orderbooks) || {};
const slippage = (policyIsObject && policy.slippage) || {};
if (Object.keys(allowedContracts).length === 0) {
  fail(`${UMBRELLA}: metadata.openclaw.web3.policy.allowedContracts is missing or empty`);
}

// --- Gate A: policy <-> SDK --------------------------------------------------

const policyChains = Object.keys(allowedContracts).map(Number).sort((a, b) => a - b);
if (JSON.stringify(policyChains) !== JSON.stringify(POLICY_CHAIN_IDS)) {
  fail(`policy allowedContracts chains are [${policyChains}]; expected [${POLICY_CHAIN_IDS}]`);
}

for (const chainId of POLICY_CHAIN_IDS) {
  const wantSettlement = sdkSettlement[chainId];
  const wantRelayer = sdkRelayer[chainId];
  if (!wantSettlement || !wantRelayer) {
    fail(`SDK has no settlement/relayer for policy chain ${chainId}`);
    continue;
  }
  if (wantSettlement === CANONICAL_SETTLEMENT) {
    fail(`chain ${chainId} uses the canonical settlement in the SDK; the skills policy must cover sovereign chains only`);
  }
  const contracts = allowedContracts[chainId] ?? [];
  if (JSON.stringify(contracts) !== JSON.stringify([wantSettlement, wantRelayer])) {
    fail(
      `chain ${chainId} allowedContracts drift: policy [${contracts}] != SDK [settlement ${wantSettlement}, relayer ${wantRelayer}]`,
    );
  }
  const spenders = allowedSpenders[chainId] ?? [];
  if (JSON.stringify(spenders) !== JSON.stringify([wantRelayer])) {
    fail(`chain ${chainId} allowedSpenders drift: policy [${spenders}] != SDK relayer [${wantRelayer}]`);
  }
  const dom = eip712[chainId] ?? {};
  if (dom.name !== 'Gnosis Protocol' || dom.version !== 'v2') {
    fail(`chain ${chainId} eip712Domain name/version is ${JSON.stringify(dom)}; expected Gnosis Protocol / v2`);
  }
  if (dom.verifyingContract !== wantSettlement) {
    fail(`chain ${chainId} eip712 verifyingContract ${dom.verifyingContract} != SDK settlement ${wantSettlement}`);
  }
  if (orderbooks[chainId] !== sdkOrderbooks[chainId]) {
    fail(`chain ${chainId} orderbook drift: policy ${orderbooks[chainId]} != SDK ${sdkOrderbooks[chainId]}`);
  }
}

// --- collect the family files ------------------------------------------------

const familyFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(rel(dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) familyFiles.push(p);
  }
};
walk(SKILLS_DIR);

const codeBlocksOf = (src) => [...src.matchAll(/```bash[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);

// --- Gate B: address allowlist ----------------------------------------------

const allowlist = new Set(Object.keys(EXAMPLE_ADDRESSES));
for (const chainId of POLICY_CHAIN_IDS) {
  if (sdkSettlement[chainId]) allowlist.add(sdkSettlement[chainId]);
  if (sdkRelayer[chainId]) allowlist.add(sdkRelayer[chainId]);
}
if (sdkFeeRecipient) allowlist.add(sdkFeeRecipient);

for (const f of familyFiles) {
  const src = read(f);
  for (const m of src.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
    if (!allowlist.has(m[0])) {
      fail(`${relative(rel('.'), rel(f))}: address ${m[0]} is not on the invariant allowlist (typo, or add it here with a reason)`);
    }
  }
  if (src.includes(CANONICAL_SETTLEMENT) || src.includes(CANONICAL_RELAYER)) {
    fail(`${f}: contains a canonical CoW GPv2 address; the family must pin the Ophis deployments only`);
  }
}

// --- Gate C: cancellation constants -----------------------------------------

const cancelSrc = read(`${SKILLS_DIR}/skills/ophis-cancel.md`);
for (const [what, want] of [
  ['single type string', CANCEL_SINGLE_TYPE],
  ['batch type string', CANCEL_BATCH_TYPE],
  ['single type hash', cancelSingleHash && `0x${cancelSingleHash}`],
  ['batch type hash', cancelBatchHash && `0x${cancelBatchHash}`],
  ['plural JSON field', 'orderUids'],
  ['plural batch typed-data field declaration', '{name:"orderUids",type:"bytes[]"}'],
  ['plural batch message field', 'message: { orderUids: $uids }'],
  ['enforced batch cap (headline)', orderUidLimit && `up to ${orderUidLimit} orders`],
  ['enforced batch cap (snippet comment)', orderUidLimit && `max ${orderUidLimit}, enforced`],
  ['enforced batch cap (errors section)', orderUidLimit && `batch cap is ${orderUidLimit} UIDs`],
]) {
  if (want && !cancelSrc.includes(want)) {
    fail(`ophis-cancel.md: missing the ${what} (${want}); it must match ${MODEL_ORDER_RS}`);
  }
}
// The WRONG singular batch type string must never appear as a signable string:
// its hash (0x85d264d5...) matches no deployed constant, so anything signed
// with it is rejected. (The plural string does not contain it as a substring:
// the wrong variant closes the paren right after "orderUid".)
if (cancelSrc.includes(CANCEL_BATCH_TYPE_WRONG_SINGULAR)) {
  fail(`ophis-cancel.md: contains the singular batch type string "${CANCEL_BATCH_TYPE_WRONG_SINGULAR}", whose hash matches no deployed constant; the deployed batch type is "${CANCEL_BATCH_TYPE}"`);
}
// A drifted cap literal (e.g. a stale larger number) must fail even though the
// correct literals are present.
for (const m of cancelSrc.matchAll(/(?:up to|max|cap is) (\d{2,})/g)) {
  if (m[1] !== orderUidLimit) {
    fail(`ophis-cancel.md: cap literal "${m[0]}" != ORDER_UID_LIMIT ${orderUidLimit} in ${MODEL_ORDER_RS}`);
  }
}

// --- Gate D: snippet lint ----------------------------------------------------

for (const name of READ_ONLY_SKILLS) {
  const blocks = codeBlocksOf(read(`${SKILLS_DIR}/skills/${name}`)).join('\n');
  for (const banned of ['cast send', 'cast wallet sign', 'PRIVATE_KEY', 'SIGNER_ARGS']) {
    if (blocks.includes(banned)) {
      fail(`${name} is read-only but a code block contains "${banned}"`);
    }
  }
}
for (const name of EXECUTION_SKILLS) {
  const blocks = codeBlocksOf(read(`${SKILLS_DIR}/skills/${name}`)).join('\n');
  if (!blocks.includes('SIGNER_ARGS')) {
    fail(`${name} is an execution skill but no code block references SIGNER_ARGS (keystore-first signing)`);
  }
  for (const banned of ['MaxUint256', 'maxuint', '2**256', 'ffffffffffffffffffffffffffffffff']) {
    if (blocks.toLowerCase().includes(banned.toLowerCase())) {
      fail(`${name}: a code block contains "${banned}" (unlimited-approval pattern; approvals are exact-amount only)`);
    }
  }
}
for (const f of familyFiles) {
  const blocks = codeBlocksOf(read(f)).join('\n');
  if (/export\s+PRIVATE_KEY/.test(blocks)) {
    fail(`${f}: a code block exports PRIVATE_KEY; raw keys in the environment are not a documented path`);
  }
}

// --- Gate E: fee + appData literals ------------------------------------------

if (sdkFeeRecipient && !umbrella.includes(`recipient: "${sdkFeeRecipient}"`)) {
  fail(`umbrella SKILL.md partnerFee recipient drifted from SDK OPHIS_PARTNER_FEE_RECIPIENT ${sdkFeeRecipient}`);
}
if (sdkSovereignBps && !umbrella.includes(`volumeBps: ${sdkSovereignBps} }`)) {
  fail(`umbrella SKILL.md partnerFee volumeBps drifted from SDK OPHIS_SOVEREIGN_VOLUME_FEE_BPS ${sdkSovereignBps}`);
}
if (sdkStableBps && !umbrella.includes(`1 bip (0.01%) sovereign base`)) {
  fail(`umbrella SKILL.md does not describe the SDK ${sdkStableBps} bp stable/sovereign rate`);
}
if (appDataVersion && !umbrella.includes(`version: "${appDataVersion}"`)) {
  fail(`umbrella SKILL.md appData version drifted from SDK APP_DATA_VERSION ${appDataVersion}`);
}

// --- Gate F: slippage latches ------------------------------------------------

const wantLatches = { defaultBips: 50, maxBips: 300, requireConfirmAboveBips: 500 };
for (const [k, v] of Object.entries(wantLatches)) {
  if (slippage[k] !== v) {
    fail(`policy slippage.${k} is ${slippage[k]}; expected ${v} (change deliberately in both the policy and this gate)`);
  }
}

// --- Report ------------------------------------------------------------------

if (errors.length > 0) {
  console.error('Agent-skills invariant check FAILED:\n');
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    '\nThe published skill family pins agents to these contracts, hosts and\n' +
      'rates. If you rotated an address, added a chain, or changed a fee, update\n' +
      `${SKILLS_DIR}/ and this gate in the SAME PR, then re-run:\n` +
      '  node scripts/check-agent-skills-invariant.mjs\n',
  );
  process.exit(1);
}

console.log(
  `OK: agent-skill family matches @ophis/sdk + backend constants for chains [${POLICY_CHAIN_IDS}] ` +
    `(${familyFiles.length} skill files checked).`,
);
process.exit(0);
