# AssetSwap

Bencho's Asset swap, adapted for Ophis. The original explanatory comments are
retained across `AssetSwap.tsx`, `AssetSwapDemoSlab.tsx`, `useAssetSwapDemo.ts`,
`AssetSwap.demo.const.tsx`, and the Ophis stylesheet. The MIT notices are adjacent.

From `apps/frontend`:

```sh
pnpm install --frozen-lockfile
pnpm start:asset-swap
```

- Ophis swap box: http://127.0.0.1:4318/#/swap
- Reference component and controls: http://127.0.0.1:4318/#/asset-swap-lab

The reference workbench requires **both** Vite development mode and
`REACT_APP_ASSET_SWAP_PREVIEW=true`. The live market swap uses the slab presentation
in normal startup and production. External-funding forms, other order types and
forms with content between their inputs retain their existing layout. Nothing is
published by these local commands.

`AssetSwapFields` applies the slab layout and continuous-turn arrow to Ophis's
existing currency inputs. On reversal the assets stay in their physical slots,
while the existing swap action exchanges their pay/receive roles. The existing
token selector mounts inside the chosen slab, with its search, compact network
chooser, import and consent flows. Existing balances, fee information, quote
calculation, recipient settings and submission controls remain owned by Ophis.
The network chooser's “View all” stays inside that slab too. Back and Escape
return to the token list, preserving its search and restoring keyboard focus.
The selector is capped at 480px and shrinks to fit short viewports. Settings,
imports and consent screens handle Escape one level at a time. A rejected trade
reversal leaves the arrow and asset positions unchanged.

`AssetSwap` is the supplied standalone reference. Its hardcoded example prices,
round lots and 0.3% example fee are isolated in the demo files and labelled on the
workbench. They are never used by `AssetSwapFields` or the trading code.

## Token mapping

All aliases live on `.swp`, never `:root`. They follow the active app/widget theme.

| Bencho property | Ophis equivalent                                                                          |
| --------------- | ----------------------------------------------------------------------------------------- |
| `--card`        | `--cow-color-paper`                                                                       |
| `--fill-slab`   | `--cow-color-paper-darker`                                                                |
| `--ink`         | `--cow-color-text`                                                                        |
| `--fill-on`     | `--cow-color-text-paper`                                                                  |
| `--ink-rgb`     | Three bare channels derived from the active theme's `text`                                |
| `--fill-on-rgb` | Three bare channels derived with the same `getContrastText(paper, text)` used by Ophis    |
| `--font-ui`     | `--ophis-font-body`                                                                       |
| `--pane-edge`   | `--cow-color-border`                                                                      |
| `--pick`        | `--cow-color-primary`                                                                     |
| `--swp-r`       | Existing large radius by default; the supplied adjustable 28px corner is a local override |

The frontend is a pnpm workspace, so its package manifest and existing lockfile
are used instead of adding an npm lockfile. `lucide-react` was added. Framer Motion
was updated from 11.3.29 to 13.4.4 for React 19 type compatibility, respecting the
workspace release-age policy. Motion elements use the app's lazy-import pattern.
Upstream releases: https://github.com/motiondivision/motion/releases

## Local checks

With the preview server running:

```sh
uv run --with playwright python scripts/asset-swap-smoke.py
uv run --with playwright python scripts/asset-swap-audit.py
pnpm exec tsc --noEmit -p apps/cowswap-frontend/tsconfig.app.json
```

The browser checks use installed Google Chrome. They cover 320, 390, 768 and
1440px, both reference themes, RGB scoping, reversal, both inline token pickers,
the nested network chooser's bounds/search/selection/Back/Escape, keyboard focus,
switching asset sets, and reduced motion. External API,
RPC and analytics requests are blocked in these checks; no wallet transaction
or real quote execution is performed. Screenshots and results go to
`/tmp/asset-swap-checks` by default.

Validation on this local branch: 29 browser cases, 9 clean accessibility scans,
the normal startup check, TypeScript and 52 targeted Jest tests passed.
File lint reports no errors; its four Fast Refresh warnings concern the supplied
JSX logo/asset constants in the demo data module.
The 5 October skill/tool review found and fixed seven further issues. Its
findings, independent follow-up, dependency advisories and limitations are in
`apps/frontend/docs/audits/asset-swap-local-2026-10-05.md`.
