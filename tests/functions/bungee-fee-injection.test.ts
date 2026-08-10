import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildUpstreamSearch, BUNGEE_INTEGRATOR_FEE_RECIPIENT } from '../../functions/api/bungee/[[path]].ts';

const QUOTE_PATH = '/api/v1/bungee/quote';
const DEST_TOKENS_PATH = '/api/v1/bungee-manual/dest-tokens';

// Independent copy per the repo convention documented in feeRecipient.ts —
// guards against an accidental edit of either the proxy constant or the
// canonical extraction below.
const CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';

test('fee recipient matches the canonical partner-fee Safe', () => {
  // Real cross-file invariant: extract the literal from the canonical source
  // (the functions/ compilation unit cannot import the frontend lib, and a
  // same-file literal alone would stay green through a deliberate rotation).
  // readFileSync throws if the canonical file moves — fail-closed.
  const canonicalSource = readFileSync(
    new URL('../../apps/frontend/libs/common-const/src/feeRecipient.ts', import.meta.url),
    'utf8',
  );
  const extracted = canonicalSource.match(/OPHIS_PARTNER_FEE_RECIPIENT = '(0x[0-9a-fA-F]{40})'/);

  assert.ok(extracted, 'OPHIS_PARTNER_FEE_RECIPIENT literal not found in feeRecipient.ts');
  assert.equal(BUNGEE_INTEGRATOR_FEE_RECIPIENT, extracted[1]);
  assert.equal(BUNGEE_INTEGRATOR_FEE_RECIPIENT, CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT);
});

test('injects the integrator fee on quote requests when the dedicated key is present', () => {
  const search = buildUpstreamSearch('?originChainId=10&inputAmount=100', QUOTE_PATH, true);
  const params = new URLSearchParams(search);

  assert.equal(params.get('feeBps'), '3');
  assert.equal(params.get('feeTakerAddress'), CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT);
  assert.equal(params.get('originChainId'), '10');
  assert.equal(params.get('inputAmount'), '100');
});

test('overrides client-supplied fee params instead of forwarding them', () => {
  const hostile = '?originChainId=10&feeBps=100&feeTakerAddress=0x2222222222222222222222222222222222222222';
  const params = new URLSearchParams(buildUpstreamSearch(hostile, QUOTE_PATH, true));

  assert.equal(params.get('feeBps'), '3');
  assert.equal(params.get('feeTakerAddress'), CANONICAL_OPHIS_PARTNER_FEE_RECIPIENT);
  assert.equal(params.getAll('feeBps').length, 1);
  assert.equal(params.getAll('feeTakerAddress').length, 1);
});

test('strips fee params on non-quote paths while preserving the rest', () => {
  const search = buildUpstreamSearch(
    '?toChainId=4663&feeBps=3&feeTakerAddress=0x2222222222222222222222222222222222222222',
    DEST_TOKENS_PATH,
    true,
  );
  const params = new URLSearchParams(search);

  assert.equal(params.get('feeBps'), null);
  assert.equal(params.get('feeTakerAddress'), null);
  assert.equal(params.get('toChainId'), '4663');
});

test('does not inject fees in keyless mode (public tier rejects fee params)', () => {
  const params = new URLSearchParams(buildUpstreamSearch('?originChainId=10&feeBps=9', QUOTE_PATH, false));

  assert.equal(params.get('feeBps'), null);
  assert.equal(params.get('feeTakerAddress'), null);
  assert.equal(params.get('originChainId'), '10');
});

test('returns an empty string when no params survive', () => {
  assert.equal(buildUpstreamSearch('?feeBps=9', DEST_TOKENS_PATH, true), '');
});
