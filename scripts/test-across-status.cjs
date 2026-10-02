const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');

const requireFrontend = createRequire(path.resolve(__dirname, '../apps/frontend/apps/cowswap-frontend/package.json'));
const { AcrossBridgeProvider } = requireFrontend('@cowprotocol/sdk-bridging');
const api = new AcrossBridgeProvider({ apiOptions: { integratorId: '0x0311', apiKey: 'test-key' } }).api;
const originalFetch = global.fetch;
const requests = [];

global.fetch = async (url, init) => {
  requests.push({ url: new URL(url), init });
  return new Response(JSON.stringify({ status: 'filled', fillTx: '0xfill' }));
};

(async () => {
  try {
    const status = await api.getDepositStatus({ originChainId: 137, depositId: '2372306' });
    assert.equal(status.status, 'filled');
    assert.equal(status.fillTx, '0xfill');
    assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
      originChainId: '137', depositId: '2372306',
    });
    await api.fetchApi('/suggested-fees', { originChainId: 137 });
    assert.equal(requests[1].url.searchParams.get('integratorId'), '0x0311');
    for (const request of requests) assert.equal(request.init.headers.Authorization, 'Bearer test-key');
    console.log('Across status query, quote attribution and authentication: PASS');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
