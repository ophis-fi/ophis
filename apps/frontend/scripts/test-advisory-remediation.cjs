#!/usr/bin/env node
'use strict';

// Exercise the installed, patched dependency graph, not leftover pnpm cache entries.
// A child process bounds synchronous parser failures; no external network is used.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

if (process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, [__filename, '--worker'], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { test } = require('node:test');
const frontend = createRequire(resolve(__dirname, '../package.json'));
const hoisted = createRequire(resolve(__dirname, '../node_modules/.pnpm/node_modules/_advisory-check.cjs'));
const { Address4, Address6 } = hoisted('ip-address');

test('ip-address: subnet checks reject cross-family addresses', () => {
  for (const [host, network] of [
    [new Address6('a00::1'), new Address4('10.0.0.0/8')],
    [new Address4('10.0.0.1'), new Address6('a00::/8')],
  ]) {
    assert.equal(host.isInSubnet(network), false);
    assert.equal(host.isHostInSubnet(network), false);
  }
  assert(new Address4('10.0.0.1').isInSubnet(new Address4('10.0.0.0/8')));
  assert(new Address6('2001:db8::1').isInSubnet(new Address6('2001:db8::/32')));
});

test('ip-address: oversized invalid input has a bounded diagnostic', () => {
  const input = '!'.repeat(1024 * 1024);
  assert.throws(() => new Address6(input), (error) => {
    assert.equal(error.name, 'AddressError');
    assert(error.message.length < 1024);
    assert((error.parseMessage || '').length < 1024);
    return true;
  });
  assert.equal(Address6.isValid(input), false);
});

test('DOMPurify: detached subtrees lose event handlers after either afterSanitize hook', () => {
  const { JSDOM } = frontend('jsdom');
  const jspdf = createRequire(frontend.resolve('jspdf', { paths: [resolve(__dirname, '../apps/cowswap-frontend')] }));
  for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes']) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    try {
      const purify = jspdf('dompurify')(dom.window);
      const root = dom.window.document.createElement('div');
      root.innerHTML = '<section id="remove-me"><img src="x" onerror="ATTACKER()"></section>';
      const image = root.querySelector('img');
      dom.window.document.body.append(root);
      purify.addHook(hook, (node) => { if (node.id === 'remove-me') node.remove(); });
      purify.sanitize(root, { IN_PLACE: true });
      assert.equal(root.querySelector('section'), null);
      assert.equal(image.hasAttribute('onerror'), false, hook);
      assert.equal(purify.sanitize('<b>Receipt</b><script>ATTACKER()</script>'), '<b>Receipt</b>');
    } finally { dom.window.close(); }
  }
});

require('../../../scripts/test-braces.cjs')(hoisted);
