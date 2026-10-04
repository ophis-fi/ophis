# Ophis website review — 2026-10-04

Base: `affbd2d3d1903e7020a950936cbb5240c60bffb0`. Prepared in the isolated
`audit/website-20261004` worktree. The owner authorized merge and deployment on
2026-10-04 after the proposed copy decisions were presented. This report records
audit and pre-release evidence; GitHub records the review and deployment outcomes.

## Coverage

The owner confirmed the complete active hostname list: `ophis.fi`, `www`, `swap`,
`explorer`, `docs`, `business`, `safe`, `rebates`, `mcp`, `compat`, `arc-mainnet`,
`optimism-mainnet`, `robinhood-mainnet`, and `unichain-mainnet` under `ophis.fi`.
All 14 were probed over HTTPS. Cloudflare authentication was expired, so completeness
rests on owner confirmation and repository discovery, not an authenticated DNS export.
Nine historical/test hostnames found in repository history did not resolve.

[URL coverage](./website-coverage-2026-10-04.csv) records 66 discovered HTML URLs and
56 app-route examples, each visited at 1440×1000 and 390×844. These groups overlap;
they are not 122 distinct page templates. The static crawl fetched 134 resources
including slash variants, API roots, sitemaps and discovery documents. No discovered
finite page URL remained unfetched. Source review covered 117 public content files,
including all 20 docs and 16 published blog articles, plus all mounted app templates.

Dynamic order, address and transaction routes were reviewed as templates with valid,
missing, malformed, disconnected and navigation examples. Arbitrary parameter values
and authenticated wallet states cannot be exhaustively enumerated. No wallet signing,
trading, token approval, reward claim, partner authentication or contact submission was
performed. Public API probes excluded GET routes known to enroll wallets.

All browser cases loaded without uncaught JavaScript errors. One comparison article
expanded the mobile layout viewport from 390 to 463 pixels because a plain contract
address could not wrap, placing consent buttons below the visible screen. Comparing
scroll width with the expanded layout width initially missed this; comparison with
the requested device width and a real button click exposed it.
The resumed audit corrected both shared article layouts. All 38 generated article
pages now pass viewport and consent-button checks at 320, 390 and 1440 pixels
(114 cases), using the local production build with external requests blocked.
This does not establish every element or authenticated flow is defect-free.
Visual review, mobile navigation, consent persistence, docs search, contact validation
and the wallet chooser supplemented the page sweep. Initial automation selector errors
were corrected and not classified as product defects.

## Confirmed findings and fixes

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| Medium | Explorer navigation could show the previous filled order under a different UID; late requests could overwrite the new selection. | Key displayed results by UID and network and ignore obsolete responses. Regression checks cover missing orders, races and network changes. Preserve the same order's last snapshot with an error during an outage so polling can recover. |
| Medium | Intent, compatibility API and browser slippage deadlines ended at response headers, leaving JSON bodies unbounded. | Keep deadlines through body consumption. Intent returns 504 TIMEOUT; compatibility calls, including trades, return retryable 503; browser slippage uses its existing fallback. Stalled-body tests failed before and pass after. |
| Medium | Arc sent pricing, slippage and permit requests to CoW services that do not serve the chain. | Reuse one shared unsupported-chain set at all three boundaries; retain existing price fallbacks. Tests cover all four operated chains. |
| Medium | Explorer fetched appData using the default chain and shared its cache across networks. | Pass the selected chain and include it in the cache key; skip the redundant request when inline appData is present. |
| Medium | Safe status stayed headed “Order proposed” with signing instructions after fulfillment, cancellation or expiry. | Render the observed order state; report failed refreshes and retain retries. Native/wrapped-token instructions no longer assume every chain uses ETH/WETH. |
| Low | Native-token images were absent on operated-chain explorer pages. | Use shared native-currency metadata and meaningful token image labels, including Arc's USDC. |
| Low | Explorer search icon had no accessible button name. | Add the Search label. |
| Low | Standalone Safe app remained on an unexplained waiting screen. | Explain how to open the custom app and link to Safe; verify desktop/mobile production previews. |
| Low | Four documentation callouts rendered literal Markdown markers. | Correct admonition title syntax; inspect generated affiliate/partner HTML. |
| Low | Six articles linked human navigation to the POST-only MCP endpoint. | Link to the MCP guide while retaining protocol endpoint URLs for clients. |
| Medium | Public copy conflicted on fee calculation, giveaway availability and API behavior, and contained universal gas/custody/MEV/audit promises. | Align verified facts with source and live data; scope security claims to the actual flow. Preserve the owner-confirmed 150 USDG giveaway and referral fee sharing. |
| Low | The public AnySwap warning told disconnected visitors their account was affected without checking their wallet. | Use a general router security notice and conditional approval instructions. |
| Low | Learn said Ophis had no articles and promised a future section despite existing guides and blog posts. | Replace the stale text with direct links to the published content; remove obsolete explanatory comments. |
| Medium | An unbroken contract address widened a mobile blog page and put consent controls outside the visible viewport. | Allow long text to wrap in the shared article body; verify viewport width and a real consent-button click. |

No changes were made to fee calculations, contract permissions, deployed addresses,
funds handling, authentication policy or accepted CSP tradeoffs.

## Data and content checks

The live reward endpoint reported enabled/available with 87 tickets at observation
time. Public copy links to current availability instead of publishing that transient
count. The original inventory remains 105 tickets totaling 150 USDG; backend
eligibility requires a qualifying $100 swap on its 12 configured chains. Arc and
Linea are not campaign chains. An enabled endpoint alone does not prove a particular
claim transaction can execute.

Published fee policy was reconciled with frontend/SDK constants and live stats:
1 bp base, plus eligible improvement capture of 80% capped at 99 bps for volatile
pairs, or 50% capped at 20 bps for stable pairs. Hosted chains also apply upstream
fees. Operated-chain out-of-market limit orders have distinct improvement handling;
the detailed fee guide retains that scope. Bridge costs remain route-specific.

Aggregate public stats matched their per-chain sums. Freshness corresponds to the
scorer's materialized publication timestamp and 26-hour threshold, not proof of
complete indexing on every upstream chain. Public health data does not establish
whether monthly affiliate payments are enabled or have executed.

137 external links were checked. Google Help's HEAD 404 returned 200 on GET and
was not changed; eleven other non-success HEAD responses were provider bot/access
restrictions, not confirmed broken links. API root 404s and MCP GET 405 were assessed
against their intended methods, rather than treated as website outages.

## Publication decisions and evidence limits

The release uses concise wording for the previously flagged claims:

- **Payout timing:** retain referral fee sharing and the code-backed 8%/12% rates;
  remove unverified monthly payout promises from public marketing. Reference docs
  retain accounting formulas and the activation, reconciliation, funding and Safe
  approval requirements. Estimated rewards are separate from executed payments.
- **Business promises:** remove one-business-day replies, higher private quotas and
  dedicated execution-lane promises; keep the contact path.
- **Operational history:** remove claims of six live vault deployments/five completed
  rebalances and exactly one current Robinhood trace source. Keep recorded factory
  addresses and the operator runbook. The daily canary schedule is present in the
  workflow and its 2026-10-04 scheduled run passed; the article describes checks,
  without treating them as proof of trade execution or uninterrupted availability.
- **Integrator payments:** distinguish charged fees from executed payouts. Do not
  assert that no partners exist or that an unauthenticated payout has completed.
- **Coinbase-stock example:** remove the unverified pair-specific upstream rate;
  refer to CoW's pair classification and the executable quote for total costs.

Operator legal/entity facts and private agreements were not independently verified.
The Caddy/tunnel client-IP path is an unconfirmed deployment lead: source topology may
collapse rate-limit buckets, but deployed trust configuration and actual client-IP
separation were unavailable. No proxy trust settings were weakened on speculation.

## Methods and validation

Applied TypeSafe/Jev evidence classification, Ponytail minimal-change review, Trail
of Bits differential/security guidance, ETHSkills frontend/QA guidance, Pashov-style
flow and trust-boundary review, and Semgrep. These are tool-assisted methods, not
independent endorsements or a whole-contract audit by those organizations.

Semgrep OSS 1.136.0 scanned 3,261 unique tracked files. Two alerts were false positives
after inspection; no confirmed vulnerability came from the scan. Nineteen parser
reports were triaged; Astro had generic/secrets coverage rather than native AST
coverage. Generated/dependency files and Solidity/vendored Rust internals were outside
this website scan. The final changed-runtime scan covered 26 files with no findings
or errors, followed by a clean scan of the last hook adjustment. Pro was unavailable;
no cross-file Pro analysis is claimed. Metrics were disabled.

One Jev batch evaluated 12 claim/evidence pairs: 5,486 input and 550 output tokens.
Nine were classified insufficient; three supported judgments had low confidence.
None was automatically accepted. Actual code, live API evidence and owner replies
were used to adjudicate them; private operational claims remain unresolved.

Validation completed:

- Intent regression suite: 36 passed; compatibility API: 86 passed, two existing
  skips. Backend typechecks passed.
- Explorer focused regressions: 28 passed; Safe suite: 13 passed. BFF and currency
  fallback suites: 16 passed, including stalled-body and operated-chain cases.
- Swap typecheck and production build; explorer, Safe, landing and docs production
  builds. Targeted changed-file lint and whitespace checks.
- Landing FAQ structured data matched 180 visible answers on 36 pages; economics,
  network/docs and agent-skill/package consistency checks passed.
- Desktop/mobile production previews confirmed explorer identity handling, loaded
  native images, accessible search and skipped inline-appData fetches; Safe's
  standalone loader is actionable. No wallet execution was simulated as live proof.
- The final swap bundle was tested on desktop/mobile using production-origin URL
  routing and the four public Arc build variables. Arc USDC/EURC selection made no
  unsupported CoW BFF/permit requests. Learn, Protocol and the general AnySwap notice
  rendered without page errors. These checks do not establish trade execution.
- Mobile full-page scrolling covered the 65 static documents and checked their loaded
  images; the swap root uses an internal scroll container and was assessed with the
  SPA checks. No broken static images were found. Separate fresh browser processes
  completed this pass after local Chrome crashes interrupted two attempts.
- Resumed landing build passed its unit, CSP and FAQ-schema gates after the two-line
  article-wrapping fix. All 114 article preview cases passed with zero page errors;
  both consent controls were inside the requested viewport, and 38 Accept / 76
  Decline clicks saved the expected preference and dismissed the banner. Temporarily
  removing the wrapping rule reproduced the original 463-pixel overflow at 390 pixels.
  Evidence: `ux/verify-article-wrap.cjs`, `ux/article-wrap-results.json` and
  `content/landing-build-resumed.log` in the artifact directory below.

## Release preparation

The interrupted technical work was recovered, including the remaining mobile
consent bug. Prior regression and static-scan evidence was inspected. Landing and
docs builds and affected copy lint were repeated after final publication edits.
Public-economics, network/docs and agent-skill invariants passed. The final staged
secret scan flagged only an existing public token-address fixture in diff context;
manual inspection confirmed it is not a credential. Whitespace checks passed.
The owner requested one logical release; this audit is kept together to avoid
repeated reviews and deployment cycles. No contract deployment, fund movement or
change to payout activation is part of this release.

Detailed logs, screenshots, source inventories, JSON/SARIF, before/after regression
evidence and claim adjudication are retained locally at
`/private/tmp/ophis-website-audit-20261004`. Large generated artifacts are excluded from
the change set to keep code review focused. The final review is requested against
the complete tested change set, with any review findings resolved before merging.
