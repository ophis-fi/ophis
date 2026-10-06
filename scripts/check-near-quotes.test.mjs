import assert from 'node:assert/strict';
import test from 'node:test';
import { checkNearQuotes } from './check-near-quotes.mjs';

const tokens = [
  { assetId: 'nep141:starknet.omft.near', decimals: 18 },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6 },
];

for (const failedBody of [
  null,
  { message: 'Quoting for this pair is not available', correlationId: 'test-reference' },
  { quote: { amountOut: '0' } },
  {},
]) {
  test(`checks both directions using dry quotes, rejecting unavailable output: ${JSON.stringify(failedBody)}`, async () => {
    const requests = [];
    const reports = [];
    const fetcher = async (url, options) => {
      if (url.endsWith('/tokens')) return Response.json(tokens);
      assert.ok(url.endsWith('/quote'));
      const request = JSON.parse(options.body);
      requests.push(request);
      assert.equal(request.dry, true);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(request.confidentiality, 'basic');
      assert.equal(request.referral, 'ophis');
      assert.equal(request.appFees[0].fee, 3);
      return Response.json(
        request.originAsset === tokens[0].assetId && failedBody !== null
          ? failedBody
          : { quote: { amountOut: '123456' } },
        { status: failedBody?.message && request.originAsset === tokens[0].assetId ? 400 : 201 },
      );
    };
    const run = checkNearQuotes({
      fetcher,
      apiKey: 'test-key',
      report: (line) => reports.push(JSON.parse(line)),
    });
    if (failedBody !== null) await assert.rejects(run, /no positive quote/);
    else await run;
    assert.deepEqual(
      requests.map((r) => [r.originAsset, r.destinationAsset, r.amount]),
      [
        [tokens[0].assetId, tokens[1].assetId, '90000000000000000000'],
        [tokens[1].assetId, tokens[0].assetId, '10000000'],
      ],
    );
    assert.equal(reports.length, 2);
    assert.equal(reports[1].available, true);
    assert.equal(reports[0].correlationId, failedBody?.correlationId);
    assert.ok(!JSON.stringify(reports).includes('test-key'));
  });
}
