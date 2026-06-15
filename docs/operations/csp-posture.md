# Content-Security-Policy posture (decision record)

Source of the policy: `apps/frontend/apps/cowswap-frontend/public/_headers`
(served on every path of the swap app). This document records the **decision**
on the three broad CSP directives the PR #608 security review flagged as a P3
tradeoff, so the posture is deliberate and reviewable rather than incidental.

**Decision (2026-06-15, post-#608 review): ACCEPT the three broad directives
as documented necessities, with the revisit triggers below.** None is safely
tightenable today without either breaking core functionality or a large
upstream-cowswap-subtree change that would routinely conflict on pulls.

## What is intentionally broad, and why

| Directive                 | Value                | Why it can't be tightened now                                                                                                                                                                                                                                                                                                 | Revisit when                                                                                                                                                 |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `frame-ancestors`         | `*`                  | The swap surface **is** an embeddable widget (see `docs/widget.md`, `@ophis/widget-react`); integrators load it cross-origin in an iframe. It's a hash-routed SPA on one origin, so CF `_headers` cannot scope framing to only the `#/.../widget` route. Matches upstream CoW (`swap.cow.fi` also ships `frame-ancestors *`). | The widget moves to a **separate origin/deploy target** — then the full swap app can drop to `frame-ancestors 'self'` and only the widget origin stays open. |
| `script-src`              | adds `'unsafe-eval'` | cowswap's token-list validator (`libs/tokens/validateTokenList.ts`) uses ajv@6, which compiles JSON-schema validators at **runtime** via `eval`. Without it, custom-token-list loading silently fails. Upstream cowswap makes the same allowance (`apps/cowswap-frontend/vercel.ts`).                                         | cowswap migrates off runtime-eval ajv (e.g. ajv standalone/precompiled validators). Then remove `'unsafe-eval'`.                                             |
| `connect-src` / `img-src` | `https:` (scheme)    | cowswap reaches **dozens** of RPC providers, subgraphs, token-list CDNs, price/quote APIs, wallet-connect relays, and per-chain explorers. An explicit allow-list is brittle and breaks on every subtree pull.                                                                                                                | A stable, enumerable backend gateway fronts all network egress — then pin `connect-src` to that host set.                                                    |

## What is already tight (kept)

- **No `'unsafe-inline'` on scripts.** Vite production bundles emit no inline
  `<script>`; GA4/gtag is a bundled module, not an inline snippet. (The handful
  of runtime inline-scripts gtag injects are _intentionally blocked_ — see the
  note block in `_headers`.)
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self' https://formspree.io`,
  `manifest-src 'self'`, `worker-src 'self' blob:`, `upgrade-insecure-requests`,
  HSTS preload, `X-Content-Type-Options: nosniff`, strict `Referrer-Policy`,
  and a locked-down `Permissions-Policy`.

## Residual-risk mitigations

- **Clickjacking** (the cost of `frame-ancestors *`) is mitigated **structurally,
  not by frame-busting**: every value-moving action (connect, token approval,
  order signature) completes only via a wallet-rendered popup **outside** the
  frame, showing the real tx / typed data — a redress overlay cannot forge it.
  In-frame-only state (slippage, theme) moves no funds. The widget↔host channel
  is separately origin-gated by the postMessage transport (`libs/iframe-transport`).
- **XSS exfiltration surface** (the cost of `connect-src https:` + `'unsafe-eval'`)
  is bounded by: no inline scripts, no `'unsafe-inline'`, `object-src 'none'`,
  `base-uri 'self'`, and `upgrade-insecure-requests` (blocks non-HTTPS egress).

## Optional future hardening (not blocking)

- Add CSP violation reporting (`report-to` + a collector endpoint) to observe
  real blocked-resource attempts in production. Deferred: needs a report sink.
