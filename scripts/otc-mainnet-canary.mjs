#!/usr/bin/env node
// Ophis OTC mainnet canary (OTC Milestone A exit gate).
//
// Static mode (--self-test, runs on PRs):
//   1. keccak-256 self-verification against standard test vectors,
//   2. ABI decode self-verification against a recorded mainnet fixture,
//   3. manifest-drift gate: the pinned identity embedded here must equal the
//      identity pinned in the frontend module (extractor proven able to fail
//      by a crafted in-memory mutation).
//
// Live mode (default, runs on a schedule):
//   chainId, runtime-code-hash, weth() wiring, nextOrderId(), getOrders
//   decode, and immutable-field reconciliation of the newest subgraph rows
//   against direct contract state. Immutable fields (maker/tokens/amounts)
//   cannot change for an existing id, so this comparison is race-free;
//   active-flag disagreement is reported as index lag, not failure.
//
// Zero dependencies. Read-only: eth_chainId / eth_getCode / eth_call only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAIN_ID = 1n;
const PUBLIC_RPC = 'https://ethereum-rpc.publicnode.com';
const CONTRACT = '0x000000fF3D7A2d373615141d7489Ca66683DbecF';
const RUNTIME_CODE_HASH = '0x8d9ad2a9d3b3d47aaa832ecc21de8775509764409ab07cdf097640396d10eda1';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const DEPLOYMENT_BLOCK = 24622661n;
const SUBGRAPH_URL =
  'https://api.goldsky.com/api/public/project_cmmkvehnce9da01u17d657vdt/subgraphs/Swapboard/1.0.0/gn';

const SELECTORS = { weth: '0x3fc8cef3', nextOrderId: '0x2a58b330', getOrders: '0x03652027' };

// A subgraph whose checkpoint stops advancing would otherwise stay green
// forever (immutable rows keep matching). ~1 hour of Ethereum blocks.
const MAX_INDEX_LAG_BLOCKS = 300n;

const FRONTEND_MANIFEST_PATH = 'apps/frontend/apps/cowswap-frontend/src/ophis/otc/otc.const.ts';

const timeoutSignal = (ms = 15_000) => AbortSignal.timeout(ms);

// --- keccak-256 (pure JS, BigInt lanes; tiny_sha3 structure) ---------------

const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTC = [1n, 3n, 6n, 10n, 15n, 21n, 28n, 36n, 45n, 55n, 2n, 14n, 27n, 41n, 56n, 8n, 25n, 43n, 62n, 18n, 39n, 61n, 20n, 44n];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK64 = (1n << 64n) - 1n;
const rotl64 = (x, n) => ((x << n) | (x >> (64n - n))) & MASK64;

function keccakF(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1n);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      bc[0] = st[j];
      st[j] = rotl64(t, ROTC[i]);
      t = bc[0];
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) st[j + i] ^= ~bc[(i + 1) % 5] & MASK64 & bc[(i + 2) % 5];
    }
    st[0] ^= KECCAK_RC[round];
  }
}

export function keccak256(bytes) {
  const rate = 136;
  const st = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + b]);
      st[i] ^= lane;
    }
    keccakF(st);
  }

  let out = '0x';
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 8; b++) out += Number((st[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  }
  return out;
}

const hexToBytes = (hex) => {
  assert.match(hex, /^0x(?:[0-9a-fA-F]{2})*$/, 'expected 0x hex bytes');
  const clean = hex.slice(2);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

// --- minimal ABI decoding ---------------------------------------------------

const word = (hex, index) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);
const decodeUintWord = (w) => {
  assert.match(w, /^[0-9a-fA-F]{64}$/, 'expected one ABI word');
  return BigInt(`0x${w}`);
};
const decodeAddressWord = (w) => {
  assert.match(w, /^0{24}[0-9a-fA-F]{40}$/, 'expected one ABI-encoded address');
  return `0x${w.slice(24)}`.toLowerCase();
};
const decodeBoolWord = (w) => {
  const value = decodeUintWord(w);
  assert.ok(value === 0n || value === 1n, 'expected one ABI-encoded bool');
  return value === 1n;
};

/** Decode getOrders(uint256[]) returndata: offset word, length word, then 6 static words per order. */
export function decodeOrdersResult(hex, orderIds) {
  assert.equal(decodeUintWord(word(hex, 0)), 32n, 'unexpected tuple[] head offset');
  const length = decodeUintWord(word(hex, 1));
  assert.equal(length, BigInt(orderIds.length), 'row count disagrees with the requested ids');
  const orders = [];
  for (let i = 0; i < orderIds.length; i++) {
    const base = 2 + i * 6;
    orders.push({
      orderId: orderIds[i],
      maker: decodeAddressWord(word(hex, base)),
      active: decodeBoolWord(word(hex, base + 1)),
      tokenA: decodeAddressWord(word(hex, base + 2)),
      amountA: decodeUintWord(word(hex, base + 3)),
      tokenB: decodeAddressWord(word(hex, base + 4)),
      amountB: decodeUintWord(word(hex, base + 5)),
    });
  }
  return orders;
}

const encodeGetOrdersCall = (orderIds) =>
  SELECTORS.getOrders +
  (32n).toString(16).padStart(64, '0') +
  BigInt(orderIds.length).toString(16).padStart(64, '0') +
  orderIds.map((id) => id.toString(16).padStart(64, '0')).join('');

// --- manifest drift gate -----------------------------------------------------

export function extractFrontendManifest(source) {
  // Exactly-one-match extraction: zero matches means the field moved (the
  // gate must fail closed), more than one means the regex could silently
  // bind to the wrong occurrence (e.g. a commented-out copy).
  const grab = (pattern, name) => {
    const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
    assert.equal(matches.length, 1, `frontend manifest field not found exactly once: ${name} (${matches.length})`);
    return matches[0][1];
  };
  return {
    contract: grab(/address:\s*'(0x[0-9a-fA-F]{40})'/, 'contract.address'),
    runtimeCodeHash: grab(/runtimeCodeHash:\s*'(0x[0-9a-fA-F]{64})'/, 'runtimeCodeHash'),
    weth: grab(/wethAddress:\s*'(0x[0-9a-fA-F]{40})'/, 'wethAddress'),
    deploymentBlock: BigInt(grab(/deploymentBlock:\s*([0-9_]+)n/, 'deploymentBlock').replaceAll('_', '')),
    subgraphUrl: grab(/subgraphUrl:\s*'([^']+)'/, 'subgraphUrl'),
  };
}

function assertManifestAgreement(extracted) {
  assert.equal(extracted.contract.toLowerCase(), CONTRACT.toLowerCase(), 'contract address drift');
  assert.equal(extracted.runtimeCodeHash.toLowerCase(), RUNTIME_CODE_HASH.toLowerCase(), 'runtime code hash drift');
  assert.equal(extracted.weth.toLowerCase(), WETH.toLowerCase(), 'WETH address drift');
  assert.equal(extracted.deploymentBlock, DEPLOYMENT_BLOCK, 'deployment block drift');
  assert.equal(extracted.subgraphUrl, SUBGRAPH_URL, 'subgraph URL drift');
}

// --- recorded fixture (mainnet block 25787579) -------------------------------

const FIXTURE_GET_ORDER_143 =
  '0x0000000000000000000000009a50a078d80f36e38edfae85affa2b8ab458e2c9' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '000000000000000000000000e9b1cfea55baa219e34301f2f31b9fd0921664ed' +
  '0000000000000000000000000000000000000000000000056bc75e2d63100000' +
  '000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' +
  '0000000000000000000000000000000000000000000000000de0b6b3a7640000';

// --- RPC / subgraph ----------------------------------------------------------

async function rpc(method, params = []) {
  const endpoint = process.env.OTC_CANARY_RPC_URL || PUBLIC_RPC;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: timeoutSignal(),
  });
  assert.ok(response.ok, `RPC ${method} returned HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.error, undefined, `RPC ${method} failed: ${JSON.stringify(body.error)}`);
  return body.result;
}

const ethCall = (data) => rpc('eth_call', [{ to: CONTRACT, data }, 'latest']);

async function fetchSubgraphOrders(count) {
  const query = `{ _meta { block { number } } orders(first: ${count}, orderBy: orderId, orderDirection: desc) { orderId maker active amountA amountB tokenA { id } tokenB { id } } }`;
  const response = await fetch(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: timeoutSignal(),
  });
  assert.ok(response.ok, `subgraph returned HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.errors, undefined, `subgraph errors: ${JSON.stringify(body.errors)}`);
  return body.data;
}

// --- modes -------------------------------------------------------------------

function selfTest() {
  // keccak-256 standard vectors
  assert.equal(keccak256(new Uint8Array(0)), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(
    keccak256(new TextEncoder().encode('abc')),
    '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
  );

  // ABI decode against the recorded mainnet fixture (single order as a 1-row batch)
  const single = decodeOrdersResult(
    `0x${(32n).toString(16).padStart(64, '0')}${(1n).toString(16).padStart(64, '0')}${FIXTURE_GET_ORDER_143.slice(2)}`,
    [143n],
  );
  assert.deepEqual(single[0], {
    orderId: 143n,
    maker: '0x9a50a078d80f36e38edfae85affa2b8ab458e2c9',
    active: true,
    tokenA: '0xe9b1cfea55baa219e34301f2f31b9fd0921664ed',
    amountA: 100000000000000000000n,
    tokenB: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    amountB: 1000000000000000000n,
  });

  // manifest drift gate against the real frontend source
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(repoRoot, FRONTEND_MANIFEST_PATH), 'utf8');
  assertManifestAgreement(extractFrontendManifest(source));

  // prove the gate can fail: a crafted drift MUST be detected
  const mutated = source.replace(CONTRACT, '0x000000fF3D7A2d373615141d7489Ca66683DbecE');
  assert.notEqual(mutated, source, 'mutation did not apply');
  assert.throws(() => assertManifestAgreement(extractFrontendManifest(mutated)), /contract address drift/);

  console.log('otc canary self-test OK: keccak vectors, fixture decode, manifest agreement, drift detection');
}

async function live() {
  const chainId = BigInt(await rpc('eth_chainId'));
  assert.equal(chainId, CHAIN_ID, `wrong chain: ${chainId}`);

  const code = await rpc('eth_getCode', [CONTRACT, 'latest']);
  assert.ok(code && code !== '0x', 'escrow contract has no bytecode');
  const codeHash = keccak256(hexToBytes(code));
  assert.equal(codeHash, RUNTIME_CODE_HASH.toLowerCase(), `runtime code hash mismatch: ${codeHash}`);

  const wethResult = decodeAddressWord(word(await ethCall(SELECTORS.weth), 0));
  assert.equal(wethResult, WETH.toLowerCase(), `weth() wiring mismatch: ${wethResult}`);

  const nextOrderId = decodeUintWord(word(await ethCall(SELECTORS.nextOrderId), 0));
  assert.ok(nextOrderId > 0n, 'nextOrderId() returned zero');

  const data = await fetchSubgraphOrders(5);
  const indexedBlock = BigInt(data._meta.block.number);
  const headBlock = BigInt(await rpc('eth_blockNumber'));
  const indexLag = headBlock > indexedBlock ? headBlock - indexedBlock : 0n;
  assert.ok(
    indexLag <= MAX_INDEX_LAG_BLOCKS,
    `index checkpoint stale: ${indexLag} blocks behind head (max ${MAX_INDEX_LAG_BLOCKS})`,
  );
  const allRows = data.orders;
  assert.ok(allRows.length > 0, 'subgraph returned no orders');

  // The RPC's 'latest' can lag the indexer by a block or two. An indexed id
  // >= this node's nextOrderId is index-vs-node skew, not corruption: skip
  // it visibly instead of paging ops with a false drift alert.
  const rows = allRows.filter((row) => BigInt(row.orderId) < nextOrderId);
  const skewSkipped = allRows.length - rows.length;
  if (skewSkipped > 0) {
    console.log(`note: ${skewSkipped} indexed order(s) ahead of this RPC node's nextOrderId — skipped`);
  }
  // Zero reconcilable rows is a failure, not a pass: either the node is far
  // behind or the index has diverged. Silence must never look like success.
  assert.ok(rows.length > 0, `no indexed rows reconcilable against this RPC node (${skewSkipped} skew-skipped)`);

  let activeDisagreements = 0;
  {
    const ids = rows.map((row) => BigInt(row.orderId));
    const onchain = decodeOrdersResult(await ethCall(encodeGetOrdersCall(ids)), ids);
    for (const [index, row] of rows.entries()) {
      const chain = onchain[index];
      // Immutable per order id: any disagreement is real corruption, not a race.
      assert.equal(row.maker.toLowerCase(), chain.maker, `order ${row.orderId}: maker drift`);
      assert.equal(row.tokenA.id.toLowerCase(), chain.tokenA, `order ${row.orderId}: tokenA drift`);
      assert.equal(row.tokenB.id.toLowerCase(), chain.tokenB, `order ${row.orderId}: tokenB drift`);
      assert.equal(BigInt(row.amountA), chain.amountA, `order ${row.orderId}: amountA drift`);
      assert.equal(BigInt(row.amountB), chain.amountB, `order ${row.orderId}: amountB drift`);
      if (row.active !== chain.active) activeDisagreements += 1;
    }
  }

  console.log(
    `otc canary live OK: code hash pinned, weth wired, nextOrderId=${nextOrderId}, ` +
      `${rows.length} newest orders reconciled (immutable fields exact; ` +
      `${activeDisagreements} active-flag lag; ${skewSkipped} skew-skipped), index block ${indexedBlock} (lag ${indexLag})`,
  );
}

const mode = process.argv[2];
if (mode === '--self-test') {
  selfTest();
} else if (mode === undefined) {
  await live();
} else {
  console.error(`unknown argument: ${mode}`);
  process.exit(2);
}
