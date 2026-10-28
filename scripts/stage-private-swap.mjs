import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const runtime = new URL('apps/railgun/dist/', root);
const frontend = new URL('apps/frontend/build/cowswap/', root);
const html = await readFile(new URL('index.html', runtime), 'utf8');
assert.match(
  html,
  /\/private\/assets\//,
  'Build the private runtime with VITE_RAILGUN_ASSET_BASE=/private/',
);
assert(!html.includes('localhost'), 'A production runtime must not contain a loopback entry URL');
await readFile(new URL('index.html', frontend));
await cp(runtime, new URL('private/', frontend), { recursive: true });
await mkdir(new URL('private-swap/', frontend), { recursive: true });
await cp(new URL('index.html', frontend), new URL('private-swap/index.html', frontend));
console.log('Staged the private engine and fresh Ophis swap document on the same origin.');
