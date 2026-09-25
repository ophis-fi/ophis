// Read-only live regression against a local, unsigned candidate driver.
// Build infra/arc-mainnet/local/build-contracts.sh first; no transaction/key APIs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../../../..');
const v = require(root + '/apps/frontend/apps/cowswap-frontend/node_modules/viem');
assert.deepEqual(process.argv.slice(2), ['--read-only-live']);
const out = root + '/infra/arc-mainnet/release/generated/arc-routing';
const artifacts = JSON.parse(fs.readFileSync(root + '/infra/arc-mainnet/local/generated/contracts.json')).contracts;
const probe = Object.entries(artifacts).find(([name]) => name.endsWith(':ReadOnlySettlementProbe'))?.[1];
assert(probe?.['bin-runtime']);
const settlement = '0x78799f98276efba1edeed32eae03a3fd8cdfec3a';
const sell = '0x3600000000000000000000000000000000000000';
const assets = {
  cirBTC: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
  WETH: '0x128cc466b61f542da60c70e3aa11c10e19b84edb',
  XAUM: '0x178b01f61cbea1d2a5581fe1621be607835ec349',
};
const owner = '0x839029e110f4954e05afad4fa222cfe93ce6d86f';
const settlementAbi = Object.entries(artifacts).find(([name]) => name.endsWith(':GPv2Settlement'))[1].abi;
const fields = [['sellToken','address'],['buyToken','address'],['receiver','address'],['sellAmount','uint256'],
  ['buyAmount','uint256'],['validTo','uint32'],['appData','bytes32'],['feeAmount','uint256'],['kind','string'],
  ['partiallyFillable','bool'],['sellTokenBalance','string'],['buyTokenBalance','string']].map(([name,type]) => ({name,type}));
const params = v.parseAbiParameters('address,address,address,uint256,uint256,bytes,bytes');
const client = v.createPublicClient({ transport: v.http('https://rpc.mainnet.arc.io', { retryCount: 0, timeout: 15000 }) });
async function main() {
  assert.equal(await client.getChainId(), 5042);
  const results = [];
  for (const [symbol, buy] of Object.entries(assets)) {
    for (const lane of ['uniswap-v3', 'kyberswap']) {
      const started = Date.now();
      const query = new URLSearchParams({ sellToken: sell, buyToken: buy, amount: '10000000', kind: 'sell',
        deadline: new Date(Date.now() + 20000).toISOString() });
      const response = await fetch(`http://127.0.0.1:11089/${lane}/quote?${query}`, { signal: AbortSignal.timeout(20000) });
      assert(response.ok, `${lane}/${symbol}: HTTP ${response.status}`);
      const quote = await response.json();
      assert.equal(quote.preInteractions.length, 0);
      const quoted = 10000000n * BigInt(quote.clearingPrices[sell]) / BigInt(quote.clearingPrices[buy]);
      // Kyber quote prices are optimistic; its configured 1% calldata floor is
      // what the solve path guarantees. Direct V3 already reports its floor.
      const minimum = lane === 'kyberswap' ? quoted * 99n / 100n : quoted;
      assert(minimum > 0n);
      const calls = quote.interactions.map((call) => ({ ...call, value: BigInt(call.value) }));
      assert(calls.every((call) => call.value === 0n));
      const simulate = (floor, omitSwap = false) => {
        const validTo = Math.floor(Date.now() / 1000) + 3600;
        const order = { sellToken: sell, buyToken: buy, receiver: owner, sellAmount: 10000000n, buyAmount: floor,
          validTo, appData: v.zeroHash, feeAmount: 0n, kind: 'sell', partiallyFillable: false,
          sellTokenBalance: 'erc20', buyTokenBalance: 'erc20' };
        const digest = v.hashTypedData({ domain: { name: 'Gnosis Protocol', version: 'v2', chainId: 5042,
          verifyingContract: settlement }, types: { Order: fields }, primaryType: 'Order', message: order });
        const uid = v.concat([digest, owner, v.toHex(validTo, { size: 4 })]);
        const trade = { sellTokenIndex: 0n, buyTokenIndex: 1n, receiver: owner, sellAmount: 10000000n,
          buyAmount: floor, validTo, appData: v.zeroHash, feeAmount: 0n, flags: 96n,
          executedAmount: 10000000n, signature: owner };
        const settleData = v.encodeFunctionData({ abi: settlementAbi, functionName: 'settle',
          args: [[sell, buy], [floor, 10000000n], [trade], [[], omitSwap ? [] : calls, []]] });
        return client.request({ method: 'eth_call', params: [
          { to: owner, data: v.encodeAbiParameters(params, [settlement, sell, buy, 10000000n, floor, uid, settleData]), gas: '0x17d7840' },
          'latest', { [owner]: { code: '0x' + probe['bin-runtime'], balance: v.toHex(1000n * 10n ** 18n) } },
        ] });
      };
      const result = await simulate(minimum);
      const [received] = v.decodeAbiParameters(v.parseAbiParameters('uint256'), result);
      assert(received >= minimum, `${lane}/${symbol}: output shortfall`);
      if (results.length === 0) await assert.rejects(simulate(minimum, true));
      results.push({ lane, symbol, minimum: String(minimum), received: String(received), milliseconds: Date.now() - started });
      console.log(`PASS ${lane}: USDC -> ${symbol}, actual output ${received} >= ${minimum}`);
    }
  }
  fs.writeFileSync(out + '/router-execution.json', JSON.stringify({ readOnly: true, results }, null, 2) + '\n');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
