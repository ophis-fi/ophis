#!/usr/bin/env node
'use strict';

// Exercise the active installed dependency, including pnpm's transitive hoist.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

const workspaces = process.argv.slice(2);
assert(workspaces.length, 'Pass at least one installed workspace directory');
for (const workspace of workspaces) {
  const root = resolve(workspace);
  const modules = existsSync(resolve(root, 'node_modules/.pnpm'))
    ? 'node_modules/.pnpm/node_modules' : 'node_modules';
  const load = createRequire(resolve(root, modules, '_cache-check.cjs'));
  const CachePolicy = load('http-cache-semantics');
  const request = { url: 'https://example.test/image', method: 'GET', headers: {} };
  const response = { status: 200, headers: { 'cache-control': 'public, max-age=600' } };
  const policy = new CachePolicy(request, response);
  assert(policy.storable());
  assert(policy.satisfiesWithoutRevalidation(request));
  assert(CachePolicy.fromObject(policy.toObject()).satisfiesWithoutRevalidation(request));
  assert.equal(policy.responseHeaders()['cache-control'], 'public, max-age=600');

  for (const directive of ['private, max-age=600', 'no-store']) {
    assert.equal(new CachePolicy(request, {
      ...response, headers: { 'cache-control': directive },
    }).storable(), false, 'shared caches must not store private/no-store responses');
  }
  const stale = new CachePolicy(request, {
    ...response, headers: { 'cache-control': 'public, max-age=0, must-revalidate' },
  });
  assert.equal(stale.satisfiesWithoutRevalidation({
    ...request, headers: { 'cache-control': 'max-stale=86400' },
  }), false);

  // 4.3.0 fixes mixed/whitespace Vary wildcards and inherited header matching.
  for (const vary of ['*', ' * ', 'Accept, *', '*, Accept']) {
    assert.equal(new CachePolicy(request, {
      ...response, headers: { ...response.headers, vary },
    }).satisfiesWithoutRevalidation(request), false, `Vary: ${vary} must never match`);
  }
  const varied = new CachePolicy({ ...request, headers: { accept: 'image/png' } }, {
    ...response, headers: { ...response.headers, vary: 'Accept' },
  });
  assert(varied.satisfiesWithoutRevalidation({ ...request, headers: { accept: 'image/png' } }));
  assert.equal(varied.satisfiesWithoutRevalidation({
    ...request, headers: Object.create({ accept: 'image/png' }),
  }), false);
  console.log(`PASS ${workspace}: cache storage, freshness, serialization and Vary safety`);
}
