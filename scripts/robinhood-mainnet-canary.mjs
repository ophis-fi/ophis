#!/usr/bin/env node

import assert from 'node:assert/strict';

const CHAIN_ID = 4663;
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const SOVEREIGN_ORDERBOOKS = [
  ['Optimism', 'https://optimism-mainnet.ophis.fi'],
  ['Unichain', 'https://unichain-mainnet.ophis.fi'],
  ['Robinhood', 'https://robinhood-mainnet.ophis.fi'],
];
const ASSET_FACADE =
  process.env.ROBINHOOD_ASSET_FACADE_URL || 'https://swap.ophis.fi/api/robinhood/assets';
const TOKEN_LIST = 'https://tokens.uniswap.org';
const TOKEN_LIST_FALLBACK = 'https://ipfs.io/ipns/tokens.uniswap.org';

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

async function fetchDefaultTokenList() {
  return fetchTokenList(TOKEN_LIST).catch(() => fetchTokenList(TOKEN_LIST_FALLBACK));
}

async function fetchTokenList(url) {
  const list = await fetchJson(url);
  assert.ok(typeof list?.name === 'string' && list.name.length > 0, 'invalid token list name');
  assert.ok(
    typeof list.timestamp === 'string' && Number.isFinite(Date.parse(list.timestamp)),
    'invalid token list timestamp',
  );
  for (const part of ['major', 'minor', 'patch']) {
    assert.ok(
      Number.isSafeInteger(list.version?.[part]) && list.version[part] >= 0,
      'invalid token list version',
    );
  }
  assert.ok(Array.isArray(list.tokens), 'invalid token list tokens');
  // The application drops non-EVM entries before validating a multichain list.
  const tokens = list.tokens.filter((token) => {
    assert.ok(typeof token?.address === 'string', 'invalid token address');
    return /^0x[0-9a-fA-F]{40}$/.test(token.address);
  });
  for (const token of tokens) {
    assert.ok(
      token && Number.isSafeInteger(token.chainId) && token.chainId > 0,
      'invalid token chain',
    );
    assert.ok(
      Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 255,
      'invalid token decimals',
    );
    for (const [field, maxLength] of [
      ['name', 100],
      ['symbol', 80],
    ]) {
      assert.ok(
        typeof token[field] === 'string' &&
          token[field].length <= maxLength &&
          !/[<>]/.test(token[field]),
        `invalid token ${field}`,
      );
    }
  }
  return { ...list, tokens };
}

async function assertIssuerTokenList(assets) {
  const url = new URL(ASSET_FACADE);
  url.searchParams.set('format', 'token-list');
  const list = await fetchTokenList(url.href);
  const expected = new Map(
    assets.flatMap((asset) =>
      asset.deployments
        .filter((deployment) => deployment.chainId === CHAIN_ID)
        .map((deployment) => [
          normalizeAddress(deployment.contractAddress),
          {
            name: asset.tokenName.replace(/[<>]/g, '').slice(0, 100),
            symbol: asset.tokenSymbol.replace(/[<>]/g, ''),
          },
        ]),
    ),
  );
  assert.ok(
    list.tokens.every((token) => token.chainId === CHAIN_ID && token.decimals === 18),
    'invalid issuer token chain or decimals',
  );
  assert.deepEqual(
    new Map(
      list.tokens.map((token) => [
        normalizeAddress(token.address),
        { name: token.name, symbol: token.symbol },
      ]),
    ),
    expected,
    'issuer token list differs from the official registry',
  );
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

async function assertSovereignOrderbook(name, baseUrl) {
  const [versionResponse, auctionResponse] = await Promise.all([
    fetch(`${baseUrl}/api/v1/version`, { signal: timeoutSignal() }),
    fetch(`${baseUrl}/api/v1/auction`, { signal: timeoutSignal() }),
  ]);
  assert.ok(
    versionResponse.ok,
    `${name} orderbook version returned HTTP ${versionResponse.status}`,
  );
  assert.ok(
    auctionResponse.ok,
    `${name} orderbook auction returned HTTP ${auctionResponse.status}`,
  );

  const version = (await versionResponse.text()).trim();
  assert.ok(version.length > 0, `${name} orderbook returned an empty version`);

  const auction = await auctionResponse.json();
  assert.ok(Number.isSafeInteger(auction.id), `${name} orderbook returned an invalid auction id`);
  assert.ok(Number.isSafeInteger(auction.block), `${name} orderbook returned an invalid block`);
  assert.ok(Array.isArray(auction.orders), `${name} orderbook returned invalid orders`);
  return `${name} ${version} (auction ${auction.id}, block ${auction.block})`;
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

  const assetsPayload = await fetchJson(ASSET_FACADE);
  const assets = assetsPayload.assets ?? [];
  assert.ok(
    assets.length >= 80,
    `deployed Stock Token facade returned only ${assets.length} assets`,
  );
  const aapl = assets.find((asset) => asset.tokenSymbol === 'AAPL');
  assert.ok(aapl, 'AAPL missing from deployed Stock Token facade');
  const aaplDeployment = aapl.deployments?.find((deployment) => deployment.chainId === CHAIN_ID);
  assert.ok(aaplDeployment?.contractAddress, 'AAPL has no Robinhood mainnet deployment');
  await assertContract('AAPL Stock Token', aaplDeployment.contractAddress);
  const multiplier = await rpc('eth_call', [
    { to: aaplDeployment.contractAddress, data: '0xa60bf13d' }, // uiMultiplier()
    'latest',
  ]);
  assert.ok(decodeUint(multiplier) > 0n, 'AAPL uiMultiplier is zero');

  await assertIssuerTokenList(assets);

  const tokenList = await fetchDefaultTokenList();
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

  const orderbooks = await Promise.all(
    SOVEREIGN_ORDERBOOKS.map(([name, baseUrl]) => assertSovereignOrderbook(name, baseUrl)),
  );

  console.log(
    `Robinhood canary passed: chain ${CHAIN_ID}; ${assets.length} official assets; ` +
      `${listedStockAddresses.size} listed assets. Sovereign orderbooks: ${orderbooks.join('; ')}.`,
  );
}

async function selfTest() {
  assert.equal(decodeUint(`0x${'0'.repeat(63)}6`), 6n);
  assert.equal(
    decodeAddress(`0x${'0'.repeat(24)}B52C38097c19cd38238c62DD36027a7918eFa890`),
    normalizeAddress(CONTRACTS.vaultRelayer),
  );
  const originalFetch = globalThis.fetch;
  const validList = {
    name: 'Test tokens',
    timestamp: '2026-09-10T00:00:00Z',
    version: { major: 1, minor: 0, patch: 0 },
    tokens: [
      {
        chainId: CHAIN_ID,
        address: CONTRACTS.weth,
        name: 'Wrapped Ether',
        symbol: 'WETH',
        decimals: 18,
      },
    ],
  };
  const nonEvmList = { ...validList, tokens: [...validList.tokens, { address: 'non-EVM' }] };
  try {
    for (const primary of [
      validList,
      nonEvmList,
      {},
      { ...validList, version: null },
      { ...validList, tokens: [null] },
      null,
    ]) {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        return url === TOKEN_LIST && primary === null
          ? new Response('Unavailable', { status: 503 })
          : Response.json(url === TOKEN_LIST ? primary : validList);
      };
      assert.deepEqual(await fetchDefaultTokenList(), validList);
      assert.deepEqual(
        calls,
        primary === validList || primary === nonEvmList
          ? [TOKEN_LIST]
          : [TOKEN_LIST, TOKEN_LIST_FALLBACK],
      );
    }
    const assets = [
      {
        tokenName: '<Wrapped Ether>',
        tokenSymbol: 'WETH',
        deployments: [{ chainId: CHAIN_ID, contractAddress: CONTRACTS.weth }],
      },
    ];
    let issuerList = validList;
    globalThis.fetch = async (url) => {
      const expectedUrl = new URL(ASSET_FACADE);
      expectedUrl.searchParams.set('format', 'token-list');
      assert.equal(url, expectedUrl.href);
      return Response.json(issuerList);
    };
    await assertIssuerTokenList(assets);
    for (issuerList of [
      {},
      { ...validList, tokens: [] },
      { ...validList, tokens: [{ ...validList.tokens[0], symbol: 'OTHER' }] },
      { ...validList, tokens: [{ ...validList.tokens[0], name: 'Other stock' }] },
    ]) {
      await assert.rejects(assertIssuerTokenList(assets));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('Robinhood canary helper self-test passed.');
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  await liveCanary();
}
