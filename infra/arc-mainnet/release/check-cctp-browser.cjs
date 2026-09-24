// Offline browser regression: all wallet signatures and chain/API responses are simulated.
// Run after the frontend build; --webkit uses mobile WebKit; --live only loads published static assets.
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const root = path.resolve(__dirname, '../../..'),
  store = root + '/apps/frontend/node_modules/.pnpm';
const { chromium, webkit } = require(
  path.join(
    store,
    fs.readdirSync(store).find((x) => x.startsWith('playwright@')),
    'node_modules/playwright',
  ),
);
const v = require(root + '/apps/frontend/apps/cowswap-frontend/node_modules/viem');
const build = root + '/apps/frontend/build/cowswap',
  out = root + '/infra/arc-mainnet/release/generated';
const live = process.argv.includes('--live'),
  mobile = process.argv.includes('--webkit');
const asset = process.argv.find((x) => x.startsWith('--asset='))?.split('=')[1] || 'USDC';
assert(['USDC', 'EURC', 'cirBTC'].includes(asset));
const expanded = asset !== 'USDC',
  btc = asset === 'cirBTC';
const destination = btc ? 1 : 8453,
  domain = btc ? 0 : 6;
const amount = btc ? 200000000 : 2000000;
const fee = expanded ? 10000000000000000n : 0n;
const owner = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a',
  TM = expanded
    ? '0x431871229103b780868f8c6bb820cd16ecf942bc'
    : '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
  MT = '0x81d40f21f12a8f0e3252bccb954d722d4c464b64';
const TOKEN = btc
  ? '0x171a4217b86a807a64eb94757db6849fb4bdbaa0'
  : expanded
    ? '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1'
    : '0x3600000000000000000000000000000000000000';
const DEST_TOKEN = btc
  ? '0x72dfb2e44f59c5ad2bafe84314e5b99a7cd5075e'
  : expanded
    ? '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'
    : '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const manager = btc
  ? '0xa1db0fda2d1bfebe2e5701fe73b252bc2b25700e'
  : expanded
    ? '0x8c27579e24f9f19d96724e19fc059dacd1469e10'
    : TM;
const tokenId = btc
  ? '0x3d26699fb5d40190fc3fa0dcbc1cd24e558355043c1997572ff9fd6efbb3fdca'
  : '0x6ca9e29fa53becc29becaf4a90b9ca7a995ad4d2234880da13ca38c657fb241c';
const burnHash = '0x' + 'ab'.repeat(32),
  approvalHash = '0x' + 'cd'.repeat(32),
  mintHash = '0x' + 'ef'.repeat(32),
  blockHash = '0x' + '11'.repeat(32);
const hook = '0x636374702d666f72776172640000000000000000000000000000000000000000';
const abi = v.parseAbi([
  'event MessageSent(bytes message)',
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
]);
const word = (n) => v.toHex(n, { size: 32 }),
  u32 = (n) => v.toHex(n, { size: 4 });
// Non-USDC body is opaque: bind it byte-for-byte to the verified source receipt.
const body = expanded
  ? v.concat([tokenId, v.pad(owner), word(amount)])
  : v.concat([
      u32(1),
      v.pad(TOKEN),
      v.pad(owner),
      word(2000000),
      v.pad(owner),
      word(20000),
      word(20000),
      word(0),
      hook,
    ]);
const message = v.concat([
  u32(1),
  u32(26),
  u32(domain),
  word(42),
  v.pad(TM),
  v.pad(TM),
  v.zeroHash,
  u32(2000),
  u32(2000),
  body,
]);
const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const toWord = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let approved = false,
  burnData,
  requests = 0,
  feeRequests = 0;
const sends = [],
  errors = [];
const log = (address, topics, data, i = 0) => ({
  address,
  topics,
  data,
  blockHash,
  blockNumber: '0x100',
  transactionHash: mintHash,
  transactionIndex: '0x0',
  logIndex: v.toHex(i),
  removed: false,
});
function receipt(hash) {
  const base = {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash,
    blockNumber: '0x100',
    from: owner,
    to: hash === approvalHash ? TOKEN : TM,
    cumulativeGasUsed: '0x186a0',
    gasUsed: '0x186a0',
    contractAddress: null,
    logsBloom: '0x' + '00'.repeat(256),
    status: '0x1',
    effectiveGasPrice: '0x3b9aca00',
    type: '0x2',
    logs: [],
  };
  if (hash === burnHash)
    base.logs = [
      log(
        MT,
        v.encodeEventTopics({ abi, eventName: 'MessageSent' }),
        v.encodeAbiParameters([{ type: 'bytes' }], [message]),
      ),
    ];
  if (hash === mintHash)
    base.logs = [
      log(
        MT,
        v.encodeEventTopics({
          abi,
          eventName: 'MessageReceived',
          args: { caller: owner, nonce: word(42), finalityThresholdExecuted: 2000 },
        }),
        v.encodeAbiParameters(
          [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
          [26, v.pad(TM), body],
        ),
      ),
      log(
        DEST_TOKEN,
        [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          v.pad(v.zeroAddress),
          v.pad(owner),
        ],
        word(expanded ? amount : 1980000),
        1,
      ),
    ];
  return base;
}
function rpc(item, chain) {
  const { method, params = [] } = item;
  let result = '0x';
  if (method === 'eth_chainId') result = v.toHex(chain);
  if (method === 'net_version') result = String(chain);
  if (method === 'eth_getCode')
    result = [TM, MT].includes(params[0]?.toLowerCase()) ? '0x60016000' : '0x';
  if (method === 'eth_blockNumber') result = '0x100';
  if (method === 'eth_getBlockByNumber')
    result = {
      number: '0x100',
      hash: blockHash,
      transactions: [],
      timestamp: '0x1',
      gasLimit: '0x1c9c380',
      gasUsed: '0x0',
    };
  if (method === 'eth_getBalance') result = v.toHex(10n ** 19n);
  if (method === 'eth_gasPrice') result = '0x3b9aca00';
  if (method === 'eth_estimateGas') result = '0x186a0';
  if (method === 'eth_getTransactionCount') result = '0x7';
  if (method === 'eth_getLogs') result = [];
  if (method === 'eth_call') {
    const input = params[0]?.data || params[0]?.input || '';
    const selector = input.slice(0, 10);
    result = toWord(0);
    if (selector === '0x313ce567') result = toWord(btc ? 8 : 6);
    if (selector === v.toFunctionSelector('localDomain()'))
      result = toWord(chain === 5042 ? 26 : domain);
    if (selector === '0x70a08231') result = toWord(amount * 5);
    if (selector === '0xdd62ed3e') result = toWord(approved ? amount : 0);
    if (selector === v.toFunctionSelector('resolveTokenAddress(bytes32)'))
      result = v.pad(chain === 5042 ? TOKEN : DEST_TOKEN);
    if (selector === v.toFunctionSelector('resolveTokenManager(bytes32)')) result = v.pad(manager);
    if (selector === v.toFunctionSelector('isTrustedDomain(uint32)')) result = toWord(1);
    if (selector === '0x95d89b41') result = v.encodeAbiParameters([{ type: 'string' }], ['USDC']);
  }
  if (method === 'eth_getTransactionReceipt') result = receipt(params[0]);
  if (method === 'eth_getTransactionByHash')
    result = {
      hash: burnHash,
      blockHash,
      blockNumber: '0x100',
      from: owner,
      to: TM,
      gas: '0x186a0',
      gasPrice: '0x3b9aca00',
      input: burnData,
      nonce: '0x7',
      transactionIndex: '0x0',
      value: v.toHex(fee),
      type: '0x0',
      v: '0x1b',
      r: word(1),
      s: word(1),
    };
  if (method === 'eth_sendTransaction') {
    sends.push(params[0]);
    if (params[0].to.toLowerCase() === TOKEN) {
      approved = true;
      result = approvalHash;
    } else {
      burnData = params[0].data;
      result = burnHash;
    }
  }
  return { jsonrpc: '2.0', id: item.id, result };
}
(async () => {
  const browser = await (mobile ? webkit : chromium).launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1050 },
      serviceWorkers: 'block',
    });
    await context.addInitScript(
      ({ owner }) => {
        const listeners = {};
        const p = {
          isMetaMask: true,
          chainId: '0x13b2',
          networkVersion: '5042',
          selectedAddress: owner,
          isConnected: () => true,
          _metamask: { isUnlocked: async () => true },
          on: (k, f) => {
            (listeners[k] ??= []).push(f);
            return p;
          },
          removeListener: (k, f) => {
            listeners[k] = (listeners[k] || []).filter((x) => x !== f);
            return p;
          },
          request: async ({ method, params = [] }) => {
            if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [owner];
            if (method === 'eth_chainId') return '0x13b2';
            if (method === 'net_version') return '5042';
            if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions')
              return [{ parentCapability: 'eth_accounts' }];
            if (method === 'wallet_switchEthereumChain') return null;
            const r = await fetch('https://cctp-wallet.invalid/rpc', {
              method: 'POST',
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            });
            return (await r.json()).result;
          },
        };
        p.enable = () => p.request({ method: 'eth_requestAccounts' });
        p.sendAsync = (x, cb) =>
          p.request(x).then((result) => cb(null, { jsonrpc: '2.0', id: x.id, result }), cb);
        p.send = (m, params) =>
          typeof m === 'string' ? p.request({ method: m, params }) : p.sendAsync(m, params);
        window.ethereum = p;
        const announce = () =>
          window.dispatchEvent(
            new CustomEvent('eip6963:announceProvider', {
              detail: {
                info: {
                  uuid: '350670db-19fa-4704-a166-e52e178b59d2',
                  name: 'CCTP Test Wallet',
                  icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                  rdns: 'io.metamask',
                },
                provider: p,
              },
            }),
          );
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      },
      { owner },
    );
    await context.route('**/*', async (r) => {
      const req = r.request(),
        u = new URL(req.url());
      if (u.hostname === 'swap.ophis.fi') {
        if (live) return r.continue();
        const f = path.resolve(build, '.' + decodeURIComponent(u.pathname));
        if (f.startsWith(build + '/') && fs.existsSync(f) && fs.statSync(f).isFile())
          return r.fulfill({
            path: f,
            contentType: mime[path.extname(f)] || 'application/octet-stream',
          });
        return r.fulfill({ path: build + '/index.html', contentType: 'text/html' });
      }
      if (u.hostname === 'iris-api.circle.com') {
        if (u.pathname.includes('/quote/cctpx/')) {
          feeRequests++;
          assert.equal(u.pathname, `/v2/quote/cctpx/${tokenId}/26/${domain}`);
          assert.equal(req.postDataJSON().amount, String(amount));
          const now = Math.floor(Date.now() / 1000);
          return r.fulfill({
            json: {
              signedQuote: '0x' + '11'.repeat(100),
              feeTotalAmount: String(fee),
              feeToken: v.zeroAddress,
              issuedAt: now,
              expiry: { mode: 'TIMESTAMP', expiresAt: now + 120 },
              items: [
                {
                  type: 'FORWARD',
                  amount: String(fee),
                  args: [String(domain), 'TransferMessage', v.zeroHash, 'false', '', owner],
                },
                { type: 'PROTOCOL', amount: '0', args: [tokenId] },
              ],
            },
          });
        }
        if (u.pathname.includes('/fees/')) {
          feeRequests++;
          return r.fulfill({
            json: [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { med: 20000 } }],
          });
        }
        return r.fulfill({
          json: {
            sourceTxHash: burnHash,
            messages: [{ message, attestation: '0x' + 'aa'.repeat(65), forwardTxHash: mintHash }],
          },
        });
      }
      if (
        [
          'rpc.mainnet.arc.io',
          'mainnet.base.org',
          'ethereum-rpc.publicnode.com',
          'cctp-wallet.invalid',
        ].includes(u.hostname) &&
        req.method() === 'POST'
      ) {
        requests++;
        assert(requests < 300);
        const data = req.postDataJSON(),
          chain =
            u.hostname === 'mainnet.base.org'
              ? 8453
              : u.hostname === 'ethereum-rpc.publicnode.com'
                ? 1
                : 5042;
        return r.fulfill({
          json: Array.isArray(data) ? data.map((x) => rpc(x, chain)) : rpc(data, chain),
        });
      }
      return r.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://swap.ophis.fi/#/bridge');
    await page
      .getByRole('heading', { name: 'Bridge tokens', exact: true })
      .waitFor({ timeout: 60000 });
    await page.screenshot({
      path: out + '/cctp-' + asset + '-' + (mobile ? 'mobile' : 'desktop') + '.png',
      fullPage: true,
    });
    assert.equal(await page.locator('select').count(), 3);
    assert.equal(feeRequests, 0, 'No idle fee polling');
    await page
      .getByRole('button', { name: 'Decline', exact: true })
      .click()
      .catch(() => {});
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await page
      .getByRole('button', { name: /CCTP Test Wallet|MetaMask/ })
      .first()
      .click({ timeout: 15000 });
    await page
      .getByRole('button', { name: 'Review bridge fee', exact: true })
      .waitFor({ timeout: 20000 });
    await page.getByRole('combobox', { name: /^Asset/ }).selectOption(asset);
    assert.equal(
      await page.getByRole('combobox', { name: /^From/ }).locator('option').count(),
      btc ? 2 : expanded ? 3 : 6,
    );
    await page.getByRole('combobox', { name: /^To/ }).selectOption(String(destination));
    await page.getByRole('combobox', { name: /^From/ }).selectOption('5042');
    await page.getByLabel(`${asset} amount`, { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Review bridge fee', exact: true }).click();
    await page
      .getByRole('button', { name: `Approve ${asset}`, exact: true })
      .click({ timeout: 15000 });
    await page
      .getByRole('button', { name: 'Review bridge fee', exact: true })
      .click({ timeout: 15000 });
    await page
      .getByRole('button', { name: `Bridge ${asset}`, exact: true })
      .click({ timeout: 15000 });
    await page
      .getByText('Tokens received. Bridge complete.', { exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(sends.length, 2, 'Exactly one approval and one burn');
    assert.equal(feeRequests, 2, 'Only explicit fee reviews');
    assert.equal(sends[1].nonce, '0x7');
    assert.equal(BigInt(sends[1].value), fee);
    assert.equal(sends[1].to.toLowerCase(), TM);
    const approval = v.decodeFunctionData({ abi: v.erc20Abi, data: sends[0].data });
    assert.equal(approval.args[0].toLowerCase(), manager);
    assert.equal(approval.args[1], BigInt(amount));
    assert.equal(errors.length, 0, 'No uncaught page error');
    await page.reload();
    await page
      .getByText('Tokens received. Bridge complete.', { exact: true })
      .waitFor({ timeout: 30000 });
    assert.equal(sends.length, 2, 'Reload never resubmits');
    await page.screenshot({
      path: out + '/cctp-complete-' + asset + '-' + (mobile ? 'mobile' : 'desktop') + '.png',
      fullPage: true,
    });
    fs.writeFileSync(
      out + '/cctp-browser-' + asset + '-' + (mobile ? 'webkit' : 'chromium') + '.json',
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          live,
          asset,
          simulated: true,
          externalRpcRequests: 0,
          simulatedRpcRequests: requests,
          feeRequests,
          transactions: sends.length,
          errors,
        },
        null,
        2,
      ),
    );
    console.log(
      `PASS ${asset} approval, burn, receipt completion and reload; all wallet/RPC responses simulated.`,
    );
  } catch (e) {
    console.error(e.message);
    const pages = browser.contexts()[0]?.pages();
    if (pages?.[0]) {
      console.log((await pages[0].locator('body').innerText()).slice(-5000));
      await pages[0].screenshot({ path: out + '/cctp-browser-failure.png', fullPage: true });
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
