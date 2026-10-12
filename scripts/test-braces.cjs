#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { test } = require('node:test');

// Shared by frontend and docs so both installed dependency graphs exercise the backport.
function registerBracesTests(hoisted) {
  const braces = hoisted('braces');
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
}

module.exports = registerBracesTests;

if (require.main === module) {
  if (process.argv[2] !== '--worker') {
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', __filename, '--worker', ...process.argv.slice(2)], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
  const workspace = resolve(process.argv[3] || resolve(__dirname, '../apps/frontend'));
  registerBracesTests(createRequire(resolve(workspace, 'node_modules/.pnpm/node_modules/_braces-check.cjs')));
}
