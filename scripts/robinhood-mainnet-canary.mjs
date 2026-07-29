#!/usr/bin/env node

import assert from 'node:assert/strict';

const CHAIN_ID = 4663;
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ORDERBOOK = 'https://robinhood-mainnet.ophis.fi';
const STOCK_API = 'https://api.robinhood.com/rhj';
const TOKEN_LIST = 'https://tokens.uniswap.org';

const CONTRACTS = {
  settlement: '0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD',
  vaultRelayer: '0xB52C38097c19cd38238c62DD36027a7918eFa890',
  ethFlow: '0xC1Ee77e8a1B85D5EED702a9bB435f434408A4d29',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
};

const timeoutSignal = (ms = 15_000) => AbortSignal.timeout(ms);
const normalizeAddress = (address) => address.toLowerCase();

export function decodeUint(hex) {
  assert.match(hex, /^0x[0-9a-fA-F]{64}$/, 'expected one ABI-encoded uint256');
  return BigInt(hex);
}

export function decodeAddress(hex) {
  assert.match(hex, /^0x[0-9a-fA-F]{64}$/, 'expected one ABI-encoded address');
  return `0x${hex.slice(-40)}`.toLowerCase();
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: timeoutSignal() });
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`);
  return response.json();
}

async function rpc(method, params = []) {
  const endpoint = process.env.ROBINHOOD_CANARY_RPC_URL || PUBLIC_RPC;
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

async function assertContract(name, address) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  assert.ok(code && code !== '0x', `${name} has no bytecode at ${address}`);
}

async function liveCanary() {
  const chainIdHex = await rpc('eth_chainId');
  assert.equal(
    Number.parseInt(chainIdHex, 16),
    CHAIN_ID,
    `RPC is not Robinhood Chain (${CHAIN_ID})`,
  );

  await Promise.all(
    Object.entries(CONTRACTS).map(([name, address]) => assertContract(name, address)),
  );

  const relayerResult = await rpc('eth_call', [
    { to: CONTRACTS.settlement, data: '0x9b552cc2' }, // vaultRelayer()
    'latest',
  ]);
  assert.equal(
    decodeAddress(relayerResult),
    normalizeAddress(CONTRACTS.vaultRelayer),
    'settlement vaultRelayer drift',
  );

  for (const [name, address, decimals] of [
    ['WETH', CONTRACTS.weth, 18n],
    ['USDG', CONTRACTS.usdg, 6n],
  ]) {
    const result = await rpc('eth_call', [{ to: address, data: '0x313ce567' }, 'latest']); // decimals()
    assert.equal(decodeUint(result), decimals, `${name} decimals drift`);
  }

  const assetsPayload = await fetchJson(`${STOCK_API}/assets`);
  const assets = assetsPayload.assets ?? [];
  assert.ok(assets.length >= 80, `official Stock Token API returned only ${assets.length} assets`);
  const aapl = assets.find((asset) => asset.tokenSymbol === 'AAPL');
  assert.ok(aapl, 'AAPL missing from official Stock Token API');
  const aaplDeployment = aapl.deployments?.find((deployment) => deployment.chainId === CHAIN_ID);
  assert.ok(aaplDeployment?.contractAddress, 'AAPL has no Robinhood mainnet deployment');
  await assertContract('AAPL Stock Token', aaplDeployment.contractAddress);
  const multiplier = await rpc('eth_call', [
    { to: aaplDeployment.contractAddress, data: '0xa60bf13d' }, // uiMultiplier()
    'latest',
  ]);
  assert.ok(decodeUint(multiplier) > 0n, 'AAPL uiMultiplier is zero');

  const tokenList = await fetchJson(TOKEN_LIST);
  const listedStockAddresses = new Set(
    (tokenList.tokens ?? [])
      .filter((token) => token.chainId === CHAIN_ID)
      .map((token) => normalizeAddress(token.address)),
  );
  assert.ok(
    listedStockAddresses.size >= 80,
    `default token list exposes only ${listedStockAddresses.size} Robinhood assets`,
  );
  assert.ok(
    listedStockAddresses.has(normalizeAddress(aaplDeployment.contractAddress)),
    'canonical AAPL is missing from the default token list',
  );

  const versionResponse = await fetch(`${ORDERBOOK}/api/v1/version`, { signal: timeoutSignal() });
  assert.ok(versionResponse.ok, `Robinhood orderbook returned HTTP ${versionResponse.status}`);
  const version = (await versionResponse.text()).trim();
  assert.ok(version.length > 0, 'Robinhood orderbook returned an empty version');

  console.log(
    `Robinhood canary passed: chain ${CHAIN_ID}; ${assets.length} official assets; ` +
      `${listedStockAddresses.size} listed assets; orderbook ${version}.`,
  );
}

function selfTest() {
  assert.equal(decodeUint(`0x${'0'.repeat(63)}6`), 6n);
  assert.equal(
    decodeAddress(`0x${'0'.repeat(24)}B52C38097c19cd38238c62DD36027a7918eFa890`),
    normalizeAddress(CONTRACTS.vaultRelayer),
  );
  console.log('Robinhood canary helper self-test passed.');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  await liveCanary();
}
