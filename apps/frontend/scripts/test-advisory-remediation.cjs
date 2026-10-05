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
const braces = hoisted('braces');

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

test('braces: bound brace and parenthesis depth across public string APIs', () => {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    for (const [open, close] of [['{', '}'], ['(', ')']]) {
      assert.doesNotThrow(() => braces[method](open.repeat(100) + 'a' + close.repeat(100)));
      for (const depth of [101, 4000]) {
        const input = open.repeat(depth) + 'a' + close.repeat(depth);
        for (const maxDepth of [undefined, 1000000, Infinity, NaN]) {
          assert.throws(() => braces[method](input, { maxDepth }), /exceeds max depth/);
        }
      }
    }
  }
  assert.throws(() => braces.parse('{{a,b},c}', { maxDepth: 1.5 }), /exceeds max depth/);
  assert.throws(() => braces.parse('{('.repeat(100) + 'a'), /exceeds max depth/);
});

test('braces: caller-supplied ASTs cannot bypass nesting and cycle limits', () => {
  for (const method of ['compile', 'expand', 'stringify']) {
    let ast = { type: 'text', value: 'a' };
    for (let i = 0; i < 101; i++) ast = { type: 'brace', nodes: [ast] };
    assert.throws(() => braces[method]({ type: 'root', nodes: [ast] }), /exceeds max depth/);
  }
  const ast = { type: 'paren', nodes: [{ type: 'text', value: 'a' }] };
  ast.parent = ast;
  assert.throws(() => braces.expand(ast), /parent chain contains a cycle/);
});

test('braces: repository glob syntax and escaped literals retain their behavior', () => {
  assert.deepEqual(braces.expand('src/{app,lib}/*.{ts,tsx}'), [
    'src/app/*.ts', 'src/app/*.tsx', 'src/lib/*.ts', 'src/lib/*.tsx',
  ]);
  assert.deepEqual(braces.expand('file{1..3}.ts'), ['file1.ts', 'file2.ts', 'file3.ts']);
  assert.deepEqual(braces.expand('foo/({a,b})'), ['foo/(a)', 'foo/(b)']);
  // The upstream branch also contains unreleased quote-parser changes. Keep
  // this security backport compatible with the published 3.0.3 grammar.
  assert.deepEqual(braces.expand('"foo{a,b}'), ['foo{a,b}']);
  assert.deepEqual(braces.expand('"a\\\\"{b,c}'), ['a\\\\b', 'a\\\\c']);
  for (const pattern of ['{{a}}', '{a,{b}}', '{}{a}', '"' + '{'.repeat(150) + '"']) {
    assert.equal(braces.stringify(braces.parse(pattern, { keepQuotes: true }), { escapeInvalid: true }), pattern);
  }
  const micromatch = hoisted('micromatch');
  assert.deepEqual(micromatch(['src/app.ts', 'src/app.js'], 'src/*.{ts,tsx}'), ['src/app.ts']);
});
