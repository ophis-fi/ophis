#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { IncomingMessage, ServerResponse } = require('node:http');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const zlib = require('node:zlib');

// Bound malformed source-map work and isolate the prototype-pollution probes.
if (process.argv[2] !== '--worker') {
  const workspaces = process.argv.slice(2);
  assert(workspaces.length, 'Pass installed workspace directories');
  for (const workspace of workspaces) {
    const result = spawnSync(process.execPath, [__filename, '--worker', workspace], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.status, 0, result.error?.message || `${workspace} regression failed`);
  }
} else {
  check(resolve(process.argv[3])).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

async function check(root) {
  const load = createRequire(join(root, 'node_modules/.pnpm/node_modules/_advisory-check.cjs'));
  const manifest = require(join(root, 'package.json'));
  const proxyaddr = load('proxy-addr');
  for (const trust of [['::ffff:10.0.0.0/8'], ['::ffff:10.0.0.0/8', '127.0.0.1']]) {
    assert.equal(proxyaddr.compile(trust)('203.0.113.9'), false);
    assert.equal(proxyaddr.compile(trust)('::ffff:203.0.113.9'), false);
  }
  assert.equal(proxyaddr.compile(['::ffff:10.0.0.0/104'])('10.0.0.1'), true);

  const { SourceMapConsumer, SourceNode } = load('source-map-js');
  const map = { version: 3, sources: ['a.js'], sourcesContent: ['a'], names: [], mappings: 'AAAA' };
  const indexed = { version: 3, sections: [{ offset: { line: 1e7, column: 0 }, map }] };
  const node = SourceNode.fromStringWithSourceMap('a\n', new SourceMapConsumer(indexed));
  assert.equal(node.toString(), 'a\n');
  assert(node.children.length < 10, 'a large section offset must not allocate empty lines');
  assert.throws(
    () =>
      new SourceMapConsumer({
        ...indexed,
        sections: [{ offset: { line: 1e7 + 1, column: 0 }, map }],
      }),
    /must not exceed/,
  );

  if (manifest.pnpm.overrides.compression) {
    const compression = load('compression');
    const original = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
    let stream;
    Object.defineProperty(zlib, 'createGzip', {
      ...original,
      value: (...args) => (stream = original.value(...args)),
    });
    try {
      for (const closeFirst of [false, true]) {
        const req = new IncomingMessage(new PassThrough());
        req.headers = { 'accept-encoding': 'gzip' };
        req.method = 'GET';
        const res = new ServerResponse(req);
        compression({ threshold: 0 })(req, res, () => {});
        res.setHeader('Content-Type', 'text/plain');
        if (closeFirst) res.emit('close');
        res.write('hello');
        res.emit('close');
        assert(stream?.destroyed, 'closing the response must release its gzip stream');
        res.destroy();
      }
    } finally {
      Object.defineProperty(zlib, 'createGzip', original);
    }
  }

  const temporary = mkdtempSync(join(tmpdir(), 'ophis-deps-'));
  try {
    if (manifest.devDependencies?.nx && process.platform !== 'win32') {
      process.env.NX_SOCKET_DIR = join(temporary, 'sockets');
      const sockets = load('nx/src/daemon/tmp-dir');
      for (const directory of [sockets.getSocketDir(), sockets.getPluginSocketDir()]) {
        const stat = statSync(directory);
        assert.equal(stat.mode & 0o777, 0o700);
        assert.equal(stat.uid, process.getuid());
      }
    }
    if (manifest.pnpm.overrides.tinypool) {
      const { default: Tinypool } = await import(pathToFileURL(load.resolve('tinypool')).href);
      const filename = join(temporary, 'worker.cjs');
      const injected = join(temporary, 'injected.mjs');
      writeFileSync(filename, 'module.exports = value => value + 1');
      writeFileSync(injected, 'throw new Error("Inherited worker options executed")');
      for (const [key, value] of Object.entries({
        execArgv: ['--import', injected],
        env: { NODE_OPTIONS: `--import ${injected}` },
        filename: injected,
      })) {
        Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
      }
      let pool;
      try {
        pool = new Tinypool({ filename, minThreads: 1, maxThreads: 1 });
        assert.equal(await pool.run(41, { signal: new AbortController().signal }), 42);
      } finally {
        for (const key of ['execArgv', 'env', 'filename']) delete Object.prototype[key];
        await pool?.destroy();
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`PASS ${root}: installed dependency security regressions`);
}
