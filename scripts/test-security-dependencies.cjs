#!/usr/bin/env node
'use strict';

// Run against installed packages, without adding test dependencies:
// node scripts/test-security-dependencies.cjs /path/to/fixture
// node scripts/test-security-dependencies.cjs node_modules/.pnpm apps/frontend/node_modules/.pnpm
// node scripts/test-security-dependencies.cjs --workspace root
// node scripts/test-security-dependencies.cjs --workspace frontend
// A fixture needs query-string 5/7, minimatch 3/5, jayson 4, stream-json 1,
// file-type 21, uuid 11 and workbox-build 6, using this repo's overrides/patches.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire, Module } = require('node:module');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const { parseArgs } = require('node:util');

// A separate process bounds synchronous decoder/filter regressions too: an
// in-process timer cannot interrupt an event-loop-blocking malformed input.
if (process.argv[2] !== '--worker') {
  const result = spawnSync(process.execPath, [__filename, '--worker', ...process.argv.slice(2)], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { values: { workspace }, positionals } = parseArgs({
  args: process.argv.slice(3), options: { workspace: { type: 'string' } }, allowPositionals: true,
});
assert(workspace === undefined || workspace === 'root' || workspace === 'frontend', '--workspace must be root or frontend');
const defaultRoots = workspace === 'root' ? ['node_modules/.pnpm']
  : workspace === 'frontend' ? ['apps/frontend/node_modules/.pnpm']
    : ['node_modules/.pnpm', 'apps/frontend/node_modules/.pnpm'];
const roots = (positionals.length ? positionals : defaultRoots.map((path) => resolve(__dirname, '..', path))).map((input) => {
  const path = resolve(input);
  return basename(path) === '.pnpm' ? path : join(path, basename(path) === 'node_modules' ? '.pnpm' : 'node_modules/.pnpm');
});
const stores = roots.filter(existsSync).map((root) => {
  const lock = join(root, 'lock.yaml');
  // pnpm retains old, unused package directories after adding a patch. Test
  // the installed lock's patch hash, not those stale cache entries.
  const patches = new Map(Array.from((existsSync(lock) ? readFileSync(lock, 'utf8') : '')
    .matchAll(/^  (\S+):\n    hash: (\S+)$/gm), ([, name, hash]) => [name, hash]));
  return { root, entries: readdirSync(root), patches };
});

function installed(name, major) {
  const found = [];
  for (const { root, entries, patches } of stores) {
    for (const entry of entries.filter((entry) => entry.startsWith(`${name}@${major}.`))) {
      const manifest = join(root, entry, 'node_modules', name, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        const hash = patches.get(`${name}@${pkg.version}`);
        if (hash && !entry.includes(`patch_hash=${hash}`)) continue;
        found.push({ require: createRequire(manifest), ...pkg });
      }
    }
  }
  assert(found.length, `${name}@${major} is missing; supply installed root/frontend .pnpm stores or a complete fixture`);
  return found;
}

async function main() {
  for (const pkg of installed('elliptic', 6)) {
    // Independent researcher vector from elliptic issue #322: P-521 needs to
    // discard seven bits even when the DRBG's first byte is zero.
    const EC = pkg.require('elliptic').ec;
    const ec = new EC('p521');
    const key = ec.keyFromPrivate('01535d22d63de9195efd4c41358ddc89c68b6cc202b558fbf48a09e95dddf953afc1b4cfed6df0f3330f986735085e367fd07030c3ab49dcd3461197b00f09a064fb', 'hex');
    const hash = createHash('sha512').update(Buffer.from('12f830e9591916ec', 'hex')).digest();
    const signature = key.sign(hash);
    assert.equal(signature.toDER('hex'),
      '308188024201e92eeaf15414d4af3ee933825131867b6cb10234f28336ac976a' +
      '99127139f23100458a9ee7184bfa64540ba385331eb3b469f491b3da013c42ad' +
      '154a5907f554f0024200db3703c6d51b8a85c10c21b7643fe751781a7ad5708e' +
      '3a944107f6da086afdc8532765871a9cabc81cec0f5b28ee59f0c72b48b72a39' +
      'ae2d230dfb03afb9968a94');
    assert(key.verify(hash, signature));
    const ethereum = new EC('secp256k1');
    const ethKey = ethereum.keyFromPrivate('1');
    const ethSig = ethKey.sign(hash.subarray(0, 32), { canonical: true });
    assert(ethKey.verify(hash.subarray(0, 32), ethSig));
    assert(ethereum.recoverPubKey(hash.subarray(0, 32), ethSig, ethSig.recoveryParam).eq(ethKey.getPublic()));
    console.log(`PASS elliptic ${pkg.version}: independent P-521 nonce vector and Ethereum sign/verify/recovery`);
  }

  for (const pkg of workspace === 'frontend' ? [] : installed('bigint-buffer', 1)) {
    const originalLoad = Module._load;
    let nativeLoads = 0;
    let convert;
    try {
      Module._load = function (name, parent, isMain) {
        if (name === 'bindings') { nativeLoads += 1; return () => ({}); }
        return originalLoad.call(this, name, parent, isMain);
      };
      convert = pkg.require('bigint-buffer');
    } finally { Module._load = originalLoad; }
    assert.equal(nativeLoads, 0, 'the memory-unsafe native converter must never load');
    for (const width of [0, 1, 8, 256, 8192]) {
      const bytes = Buffer.alloc(width, 0xff);
      const expected = width ? (1n << BigInt(width * 8)) - 1n : 0n;
      assert.equal(convert.toBigIntBE(bytes), expected);
      assert.equal(convert.toBigIntLE(bytes), expected);
      assert.deepEqual(convert.toBufferBE(expected, width), bytes);
      assert.deepEqual(convert.toBufferLE(expected, width), bytes);
    }
    assert.equal(convert.toBigIntLE(Buffer.from([1, 2])), 513n);
    assert.equal(convert.toBigIntBE(Buffer.from([1, 2])), 258n);
    console.log(`PASS bigint-buffer ${pkg.version}: no native binding, empty/large and endian round trips`);
  }

  for (const pkg of workspace === 'root' ? [] : installed('request', 2)) {
    const request = pkg.require('request');
    const server = createServer((req, res) => {
      if (req.url === '/same' || req.url === '/cross') {
        res.writeHead(302, { Location: req.url === '/same' ? '/ok' : `https://127.0.0.1:${server.address().port}/ok` });
      }
      res.end('ok');
    });
    try {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const url = `http://127.0.0.1:${server.address().port}`;
      const get = (path) => new Promise((done) => request.get({ url: url + path, proxy: null, timeout: 2000 }, (error, response, body) => done({ error, response, body })));
      const same = await get('/same');
      assert.ifError(same.error);
      assert.equal(same.response.statusCode, 200);
      assert.equal(same.body, 'ok');
      const cross = await get('/cross');
      assert.equal(cross.error?.code, 'ERR_INVALID_PROTOCOL', 'cross-protocol redirects must retain the filtering agent');
    } finally { await new Promise((done) => server.close(done)); }
    console.log(`PASS request ${pkg.version}: same-protocol redirect succeeds, cross-protocol agent bypass rejected`);
  }

  for (const pkg of workspace === 'root' ? [] : installed('uuid', 3)) {
    for (const version of [1, 3, 4, 5]) {
      const uuid = pkg.require(`uuid/v${version}`); // Preserve request's legacy deep imports.
      const options = version === 1 ? { msecs: 0, nsecs: 0, node: [0, 0, 0, 0, 0, 0], clockseq: 0 } : { random: Array(16).fill(0) };
      const generate = (buf, offset) => version === 3 || version === 5 ? uuid('ophis', uuid.DNS, buf, offset) : uuid(options, buf, offset);
      const bytes = Buffer.alloc(18, 0xab);
      assert.equal(generate(bytes, 1), bytes);
      assert.equal(bytes[0], 0xab);
      assert.equal(bytes[17], 0xab);
      assert.equal(pkg.require('uuid/lib/bytesToUuid')(bytes.subarray(1, 17)), generate());
      for (const offset of [-1, 3, 0.5, NaN, Infinity]) {
        const output = Buffer.alloc(18, 0xab);
        assert.throws(() => generate(output, offset), RangeError);
        assert(output.every((byte) => byte === 0xab), 'rejected UUID writes must leave the buffer intact');
      }
      assert.throws(() => generate(Buffer.alloc(15)), RangeError);
    }
    console.log(`PASS uuid ${pkg.version}: v1/v3/v4/v5 legacy APIs and atomic output bounds`);
  }

  for (const name of workspace === 'root' ? [] : ['web3-core-method', 'web3-core-subscriptions']) {
    for (const pkg of installed(name, 1)) {
      const exported = pkg.require(name);
      const Constructor = name === 'web3-core-method' ? exported : exported.subscriptions;
      try {
        for (const name of ['__proto__.ophisPolluted', 'constructor.prototype', 'eth.__proto__', 'prototype', 'constructor']) {
          assert.throws(() => new Constructor({ name, call: 'eth_test', type: 'eth' }).attachToObject({}), /Unsafe method namespace/);
          assert.equal(Object.prototype.ophisPolluted, undefined);
        }
        const target = {};
        new Constructor({ name: 'eth.test', call: 'eth_test', type: 'eth' }).attachToObject(target);
        assert.equal(typeof target.eth.test, 'function');
        new Constructor({ name: 'subscribe', call: 'eth_test', type: 'eth' }).attachToObject(target);
        assert.equal(typeof target.subscribe, 'function');
        const prototype = { eth: {} };
        const inherited = Object.create(prototype);
        new Constructor({ name: 'eth.test', call: 'eth_test', type: 'eth' }).attachToObject(inherited);
        assert.equal(typeof inherited.eth.test, 'function');
        assert.equal(prototype.eth.test, undefined, 'attachment must never traverse an inherited namespace');
      } finally { delete Object.prototype.ophisPolluted; }
      console.log(`PASS ${name} ${pkg.version}: prototype paths rejected, normal single/nested attachment preserved`);
    }
  }

  for (const major of workspace === 'root' ? [7] : [5, 7]) {
    for (const pkg of installed('query-string', major)) {
      const query = pkg.require('query-string');
      const decoder = pkg.require('decode-uri-component');
      assert.equal(typeof decoder, 'function', 'legacy CommonJS consumers must receive a callable decoder');
      assert.deepEqual({ ...query.parse('text=caf%C3%A9+%E2%82%AC&literal=%2B&empty=&flag&repeat=1&repeat=2') }, {
        text: 'café €', literal: '+', empty: '', flag: null, repeat: ['1', '2'],
      });
      assert.deepEqual({ ...query.parse('bad=%E0%A4%A&mixed=%41%FE%42&bom=%FE%FF&percent=%G1&once=%252B') }, {
        bad: '%E0%A4%A', mixed: 'A%FEB', bom: '\uFFFD\uFFFD', percent: '%G1', once: '%2B',
      });
      const original = { plus: '+', text: 'a + café' };
      assert.deepEqual({ ...query.parse(query.stringify(original)) }, original);
      const malformed = '%FE'.repeat(100_000);
      assert.equal(query.parse(`value=${malformed}%41`).value, `${malformed}A`);
      console.log(`PASS query-string ${pkg.version}: UTF-8, malformed input, plus semantics, 300 KB malformed run`);
    }
  }

  for (const pkg of installed('stream-json', 1)) {
    const { parser } = pkg.require('stream-json');
    const { streamValues } = pkg.require('stream-json/streamers/StreamValues');
    async function values(input, filter) {
      const output = [];
      await pipeline(Readable.from([input]), parser(), ...(filter ? [filter] : []), streamValues(), new Writable({
        objectMode: true,
        write(chunk, _, callback) { output.push(chunk.value); callback(); },
      }));
      return output;
    }
    const input = JSON.stringify({ keep: { n: 1 }, drop: [2, 3] });
    const cases = [
      ['Filter', 'keep', { keep: { n: 1 } }],
      ['Pick', 'keep', { n: 1 }],
      ['Replace', 'drop', { keep: { n: 1 }, drop: null }],
      ['Ignore', 'drop', { keep: { n: 1 } }],
    ];
    for (const [name, filter, expected] of cases) {
      const Filter = pkg.require(`stream-json/filters/${name}`);
      assert.deepEqual(await values(input, new Filter({ filter })), [expected]);
      // A non-matching path forces each filter to traverse its path stack,
      // exercising the quadratic construction fixed by the shared depth cap.
      for (const [open, close] of [['{"a":', '}'], ['[', ']']]) {
        const deep = open.repeat(8192) + '0' + close.repeat(8192);
        await assert.rejects(values(deep, new Filter({ filter: 'missing' })), {
          name: 'RangeError', message: /JSON nesting exceeds 1024 levels/,
        });
      }
    }
    assert.deepEqual(await values(input), [JSON.parse(input)]);
    console.log(`PASS stream-json ${pkg.version}: all four filters, deep objects/arrays, StreamValues`);
  }

  for (const pkg of workspace === 'frontend' ? [] : installed('jayson', 4)) {
    const requests = [{ jsonrpc: '2.0', method: 'ping', id: 1 }, { jsonrpc: '2.0', result: { ok: true }, id: 2 }];
    const received = [];
    await new Promise((done, reject) => {
      const input = Readable.from(requests.map((value) => JSON.stringify(value) + '\n'));
      pkg.require('jayson/lib/utils').parseStream(input, {}, (error, value) => {
        if (error) return reject(error);
        received.push(value);
      });
      input.on('end', () => setImmediate(done));
    });
    assert.deepEqual(received, requests);
    console.log(`PASS jayson ${pkg.version}: consecutive JSON-RPC messages through StreamValues`);
  }

  for (const major of [3, 5]) {
    for (const pkg of installed('minimatch', major)) {
      const minimatch = pkg.require('minimatch');
      assert.equal(typeof pkg.require('brace-expansion'), 'function');
      const braceVersion = pkg.require('brace-expansion/package.json').version;
      assert.equal(braceVersion.split('.')[0], major === 3 ? '1' : '2');
      assert(minimatch('src/index.ts', 'src/*.{js,ts}'));
      assert(minimatch('file2.txt', 'file{1..3}.txt'));
      assert(minimatch('a/c/file.ts', '{a,b}/{c,d}/*.{js,ts}'));
      assert(!minimatch('src/index.py', 'src/*.{js,ts}'));
      assert.deepEqual(minimatch.braceExpand('file{1..3}.txt'), ['file1.txt', 'file2.txt', 'file3.txt']);
      console.log(`PASS minimatch ${pkg.version}: brace-expansion ${braceVersion}, callable API and expressions`);
    }
  }

  for (const pkg of workspace === 'root' ? [] : installed('workbox-build', 6)) {
    const directory = mkdtempSync(join(tmpdir(), 'ophis-precache-'));
    try {
      writeFileSync(join(directory, 'app.js'), 'console.log("precache");');
      const manifest = await pkg.require('workbox-build').getManifest({
        globDirectory: directory, globPatterns: ['**/*.js'],
      });
      assert.deepEqual(manifest.warnings, []);
      assert.equal(manifest.count, 1);
      assert.equal(manifest.manifestEntries[0].url, 'app.js');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    console.log(`PASS workbox-build ${pkg.version}: glob API generates a nonempty precache`);
  }

  for (const pkg of workspace === 'root' ? [] : installed('file-type', 21)) {
    const { fileTypeFromBuffer } = await import(pathToFileURL(pkg.require.resolve('file-type')).href);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=', 'base64');
    const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
    assert.deepEqual(await fileTypeFromBuffer(png), { ext: 'png', mime: 'image/png' });
    assert.deepEqual(await fileTypeFromBuffer(zip), { ext: 'zip', mime: 'application/zip' });
    console.log(`PASS file-type ${pkg.version}: fileTypeFromBuffer PNG/ZIP`);
  }

  for (const pkg of installed('uuid', 11)) {
    const uuid = pkg.require('uuid');
    const bytes = Buffer.alloc(16);
    const random = uuid.v4();
    assert(uuid.validate(random));
    assert.equal(uuid.version(random), 4);
    assert.equal(uuid.v4({ random: new Uint8Array(16) }, bytes), bytes);
    assert.equal(uuid.stringify(bytes), '00000000-0000-4000-8000-000000000000');
    const expected = uuid.v5('ophis-security', uuid.v5.DNS);
    assert.equal(uuid.v5('ophis-security', uuid.v5.DNS, bytes), bytes);
    assert.equal(uuid.stringify(bytes), expected);
    assert.deepEqual(Buffer.from(uuid.parse(expected)), bytes);
    assert(uuid.validate(expected));
    assert.equal(uuid.version(expected), 5);
    console.log(`PASS uuid ${pkg.version}: named exports, v4/v5 buffer output, parse/stringify`);
  }
}

// An unresolved Promise does not keep Node alive. Fail if a broken stream lets
// the process exit before every check completes, even without throwing.
process.exitCode = 1;
main().then(() => { process.exitCode = 0; }, (error) => { console.error(error); });
