# AssetSwap local review — 5 October 2026

Scope: the uncommitted Bencho AssetSwap component, its Ophis trading-form and
token-picker integration, stylesheet, preview gate, and dependency changes in
`local/asset-swap-20261004`. Nothing was committed, pushed, merged or deployed.

## Result

Seven issues were fixed during this review. The independent follow-up found no
remaining actionable issues in the reviewed changes (confidence 0.87). This is
a scoped frontend review, not a protocol/security certification.

| Finding | Fix | Evidence |
| --- | --- | --- |
| A rejected reverse route still advanced the arrow and exchanged the displayed fields. | The swap handler reports rejection; AssetSwap leaves its direction and field positions unchanged. | Existing route tests now assert acceptance/rejection; three component cases cover rejected, accepted and legacy callbacks. |
| Removing the form could leave its picker attached to a detached portal host, retaining scroll and quote locks. | Closing the AssetSwap host also closes the token selector. | Component unmount regression; independent source review of the selector lifecycle. |
| Escape could leave Manage state behind or fail to cancel an import/consent view. | Escape follows the active view's Back/Cancel action and stops before outer/global listeners. | Six focused hook tests; browser checks return through Manage, close, then reopen into the normal token list. |
| Replacing a picker view could leave focus on the document body. | Recover focus after the focused control is removed, while preserving deliberate focus outside the inline picker. | Both slabs tested through settings, Back/Escape and focus restoration. |
| The fixed 480px picker exceeded short windows; automatic focus could scroll its top out of view. | Cap height to the visible viewport, scroll the picker contents, handle viewport resizing and prevent the initial focus from scrolling again. | 844×390, 390×520, both slabs, and resizing while open. |
| Bencho's translucent secondary text failed contrast checks in Ophis's palettes. | Use Ophis's existing secondary-text token locally. | axe-core checks of light/dark demo states now report no violations. |
| Cold loading of the lazy motion components could suspend the whole swap page. | Add a local Suspense boundary and a labelled loading state with reserved space. | Browser test holds the motion module request, verifies the page header/loading state, then releases it and checks the swap appears. |

The earlier full-screen “View all” defect remains covered by the responsive
network-picker regression tests.

## Skills and tools actually used

- **second-opinion:** independent Codex CLI review in an ephemeral, read-only
  session, followed by a separate review of the fixes. The skill's suggested
  GPT-5.3/GPT-5.2 Codex models were unsupported by this account. The successful
  reviews used the configured **GPT-6-Astra**, with xhigh reasoning. Its supplied
  response schema also needed a local copy updated for strict required fields.
- **web-design-guidelines:** reviewed against the
  [current Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md),
  focusing on keyboard operation, focus, contrast, motion, loading, and layout.
- **webapp-testing:** Python Playwright with installed Chrome, screenshots,
  runtime-error checks, request interception, and **axe-core 4.11.4**.
- TypeScript, targeted ESLint, Nx/Jest, `pnpm audit --prod --json`, Git diffs,
  dependency comparison with the base lockfile, and original-comment comparison.

The reviewers were instructed to inspect source only. Browser and unit tests
were run separately by the implementing agent. No human reviewer participated.

## Verification

| Check | Result |
| --- | --- |
| Independent follow-up | No actionable findings; “patch is correct”, confidence 0.87 |
| Jest | 52 tests passed across 6 suites |
| Responsive browser matrix | 13 cases passed: 320/390/768/1440px, both themes, direction changes, both pickers and nested networks, keyboard operation, asset-set changes and reduced motion |
| Additional browser audit | 16 cases passed: accessibility, duplicate-asset selection, settings lifecycle, short windows, resize, rapid opening/closing and slow module loading |
| Accessibility subset | 9 axe scans, zero reported WCAG 2 A/AA and 2.1 AA violations in the tested component states |
| TypeScript | Passed |
| ESLint on all changed TypeScript files | Zero errors; 4 Fast Refresh warnings in the supplied JSX asset-constant module |
| Normal startup with preview disabled | Original swap/modal available, no lab route, no browser runtime errors |
| Original explanatory comments | All 32 TSX and 10 CSS block comments retained |
| Demo isolation | Example assets/prices/0.3% fee remain confined to reference-demo code |
| `git diff --check` | Passed |

The first accessibility measurements included the application's entrance fade.
The closed live-box measurement waits for that fade to settle. The settings test
also waits for restored focus before sending the next Escape, avoiding a race
between consecutive test keystrokes and the view transition.

## Dependency scan at the time of the component review

**Correction after dependency verification:** five of these nine alerts were
already addressed by applied repository patches. The remaining four findings
have since been remediated locally. See the [dependency verification report](dependency-remediation-2026-10-05.md)
for impact, patch verification, upgrades, tests and the six remaining version-only alerts.

The production-dependency audit reported **9 advisories: 1 high, 4 moderate,
4 low**. Every affected version is already present in the base lockfile. None
names `framer-motion`, `motion-dom`, `motion-utils`, or `lucide-react`.

The high advisory concerns `braces@3.0.3` and nested-pattern denial of service
([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)). Other
affected packages are `request`, `web3-core-method`, `web3-core-subscriptions`,
`elliptic`, `uuid`, `ip-address` (two advisories), and `dompurify`.
These unrelated dependencies were not upgraded during this component review.
The scan flags affected versions; it does not assess applied patches or
exploitability in Ophis's runtime.

## Reproduce and inspect

From `apps/frontend`, start `pnpm start:asset-swap`, then:

```sh
uv run --with playwright python scripts/asset-swap-smoke.py
uv run --with playwright python scripts/asset-swap-audit.py
pnpm exec tsc --noEmit -p apps/cowswap-frontend/tsconfig.app.json
NX_DAEMON=false pnpm exec nx run cowswap-frontend:test --testPathPatterns 'useOnSwitchTokens.test|AssetSwapFields.test|useInlineTokenPickerBack.test|SelectTokenWidget/index.test|FinishedStep.test|useOrderProgressBarProps.test' --runInBand
pnpm audit --prod --json
```

The browser scripts require installed Google Chrome and the workspace's
axe-core package. The dependency audit exits nonzero on flagged versions even
when source patches are applied; consult the dependency verification report.

Machine-readable results, independent findings, dependency details and source
hashes are saved in [the evidence file](asset-swap-local-2026-10-05.evidence.json).
Full command logs and audit screenshots are in
`/private/tmp/ophis-asset-swap-audit-20261005`; responsive screenshots are in
`/private/tmp/asset-swap-checks`.

## Limits

Browser contexts blocked external API/RPC/analytics requests and permitted
local app resources plus images/fonts. No wallet connection, approval, signing,
live quote execution or trade was performed. Import/consent cancellation and
host cleanup have unit/source coverage; actual wallet-backed confirmation was
not exercised. Mobile checks used Chromium viewport emulation, not physical
phones or Safari. The production bundle was not built or deployed. Automated
accessibility checks do not establish complete accessibility conformance.
