#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

// Also callable against an isolated fixture: node this-file /fixture/package.json.
// GHSA-gcqx-w48m-w2h4 backport (patches/deepmerge@4.3.1.patch): __proto__, constructor
// and prototype are never copied, from the target or the source.
function testDeepmerge(requirePackage) {
  const deepmerge = requirePackage('deepmerge');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const payload = () => JSON.parse(`{"${key}":{"polluted":1},"kept":1}`);
    const results = [
      deepmerge({}, payload()),
      deepmerge(payload(), {}),
      deepmerge(payload(), payload()),
      deepmerge(Object.create(null), payload()),
      deepmerge.all([payload(), {}, payload()]),
      deepmerge({ nested: payload() }, { nested: payload() }).nested,
      deepmerge([payload()], [payload()])[1],
    ];
    for (const result of results) {
      assert.equal(Object.getPrototypeOf(result), Object.prototype, `${key} changed the result prototype`);
      assert.equal(Object.prototype.hasOwnProperty.call(result, key), false, `${key} was copied`);
      assert.equal(result.polluted, undefined);
      assert.equal(result.kept, 1);
    }
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);

  // Ordinary merges are unchanged: values, key order, array concat, cloning, symbols.
  const target = { a: 1, b: { c: [1], k: 'x' }, proto: 1, __proto: 2, constructors: 3 };
  const source = { b: { c: [2], d: 2 }, e: 3, prototypes: 4 };
  const merged = deepmerge(target, source);
  assert.equal(JSON.stringify(merged),
    '{"a":1,"b":{"c":[1,2],"k":"x","d":2},"proto":1,"__proto":2,"constructors":3,"e":3,"prototypes":4}');
  assert.notEqual(merged.b, target.b);
  assert.deepEqual(deepmerge([1, { x: 1 }], [2]), [1, { x: 1 }, 2]);
  assert.deepEqual(deepmerge({ a: [1] }, { a: [2] }, { arrayMerge: (_t, s) => s }), { a: [2] });
  const kept = Symbol('kept');
  const replaced = Symbol('replaced');
  const symbols = deepmerge({ [kept]: 1, [replaced]: { a: 1 } }, { [replaced]: { b: 2 } });
  assert.equal(symbols[kept], 1);
  assert.deepEqual(symbols[replaced], { a: 1, b: 2 });
  return requirePackage('deepmerge/package.json').version;
}

module.exports = testDeepmerge;

if (require.main === module) {
  try {
    const version = testDeepmerge(createRequire(resolve(process.argv[2] || 'package.json')));
    console.log(`PASS deepmerge ${version}: __proto__/constructor/prototype never copied; ordinary merges unchanged`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
