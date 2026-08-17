# Ophis Lite local fixed-output build

**Date:** 2026-08-17

**Scope:** Milestone B local prototype

**Deployment/publication:** None

## Result

The first Ophis Lite slice builds one dependency-free HTML document from a
reviewed source file. The build performs no transformation, embeds no RPC or
service endpoint, and exposes no wallet, signature, approval, order, swap, or
transaction action.

| Property | Value |
|---|---|
| Version | `0.0.1` |
| Bytes | `7,432` |
| SHA-256 | `0x9e08bc55300f60757d9266c6a327ec8ca564bb01d37baf20a53bbde3fb98c1c9` |
| Keccak-256 | `0x68bd2aaa61d91a4b91d80cf4403897eb78fe205634c5609e22019df372edfb11` |
| Deterministic chunks | 1 at a maximum of 23,000 bytes |
| External resources | 0 |
| Executable scripts | 0 |
| Network APIs | 0 |

The reviewed identity is pinned in
`apps/ophis-lite/config/expected-manifest.json`. Generated files remain ignored
under `dist/`; the source and expected manifest are the committed inputs.

## Build guardrails

The builder fails closed on:

- script and link elements;
- remote URLs and browser network APIs;
- time, randomness, or unresolved template tokens;
- machine-local source paths;
- non-LF line endings;
- missing Ophis identity, CSP, or no-execution markers; and
- unexpected files already present in the build output directory.

The HTML meta CSP disables scripts and connections. A future serving gateway
must additionally send `frame-ancestors 'none'` as an HTTP response header;
browsers do not enforce that directive from a meta tag.

## Verification

`pnpm --filter @ophis/lite verify` passed:

- deterministic repeated-build comparison;
- exact comparison with the pinned manifest; and
- fail-closed executable/external-resource fixture.

The built file was also opened locally in Chromium at desktop and 390×844
mobile widths. The accessibility tree contained banner, main, named regions,
one level-one heading, status headings, and content information. The visual
layout remained readable at both widths and contained no interactive element.

## Deliberate boundary

This slice proves deterministic interface bytes only. It does not implement a
contract root, resolver, wallet capability model, signing domain, orderbook
health check, or order submission. Those require separate tests and review.
There is no deployment command or credential path in this package.
