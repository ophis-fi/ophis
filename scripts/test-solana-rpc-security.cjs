'use strict';

const assert = require('node:assert/strict');

module.exports = async function testSolanaRpc(requirePackage) {
  // The override is limited to Solana's browser client. General jayson TCP
  // framing changed in v5 and is not the interface used by this dependency.
  assert.equal(requirePackage('jayson/package.json').version, '5.0.0');
  const { Connection, PublicKey } = requirePackage('@solana/web3.js');
  const methods = [];
  const connection = new Connection('http://127.0.0.1:1', { fetch: async (_url, options) => {
    const request = JSON.parse(options.body);
    function response({ id, method }) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      methods.push(method);
      const result = method === 'getBalance' ? { context: { slot: 123 }, value: 321 }
        : method === 'getVersion' ? { 'solana-core': '1.18.0', 'feature-set': 1234 }
          : method === 'getSlot' ? 123 : null;
      return method === 'error' ? { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params' } }
        : { jsonrpc: '2.0', id, result };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(Array.isArray(request) ? request.map(response) : response(request)) };
  } });
  assert.equal(await connection.getBalance(new PublicKey('11111111111111111111111111111111')), 321);
  assert.equal(await connection.getSlot(), 123);
  assert.deepEqual(await connection.getVersion(), { 'solana-core': '1.18.0', 'feature-set': 1234 });
  const batch = await connection._rpcBatchRequest([
    { methodName: 'getSlot', args: [] }, { methodName: 'getVersion', args: [] },
  ]);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].result, 123);
  assert.equal(batch[1].result['feature-set'], 1234);
  assert.equal((await connection._rpcRequest('error', [])).error.code, -32602);
  assert.deepEqual(methods, ['getBalance', 'getSlot', 'getVersion', 'getSlot', 'getVersion', 'error']);

  const badJson = new Connection('http://127.0.0.1:1', { fetch: async () => ({ ok: true, status: 200, text: async () => 'invalid-json' }) });
  await assert.rejects(badJson.getSlot(), SyntaxError);
  const failed = new Connection('http://127.0.0.1:1', { fetch: async () => ({ ok: false, status: 503, statusText: 'Unavailable', text: async () => 'unavailable' }) });
  await assert.rejects(failed.getSlot(), /503/);
  const RpcClient = requirePackage('jayson/lib/client/browser');
  const custom = new RpcClient((_request, done) => done(null, ''), { generator: () => 'custom-id' });
  assert.equal(custom.request('getSlot', []).id, 'custom-id');
  assert.equal(custom.request('notify', [], null).id, undefined);
};
