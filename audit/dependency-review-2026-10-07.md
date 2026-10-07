# Dependency follow-up review: 2026-10-07

## Decision

Renew the reviewed braces exception (GHSA-vfj7-8cjw-p6xm) in the frontend and docs audit jobs
through **2026-11-17**; it would otherwise lapse after 2026-10-18 and fail the required frontend
audit on every pull request. In the same change, raise three dependency floors found while
reviewing #1542. No gate logic changes.

## braces: exception renewed, still not a package fix

Status checked on 2026-10-07:

- No fixed release exists. The npm `latest` tag is still 3.0.3 (published 2024-05-21), and the
  GitHub advisory is not withdrawn and lists no patched version.
- Upstream: [micromatch/braces#72](https://github.com/micromatch/braces/pull/72) was closed unmerged
  on 2026-10-05. Third-party fixes [#78](https://github.com/micromatch/braces/pull/78) and
  [#79](https://github.com/micromatch/braces/pull/79), opened 2026-10-06, remain open, unreviewed
  and unmerged; on 2026-10-07 the maintainer closed later duplicates (#81 as a duplicate of #79).
  A maintainer disputes the report in
  [issue #70](https://github.com/micromatch/braces/issues/70): the existing `maxLength` option
  already bounds nesting depth. A community correction to the advisory,
  [github/advisory-database#10132](https://github.com/github/advisory-database/pull/10132), is
  open and unmerged.
- Since the 2026-10-04 review, #1532 patched the frontend copy locally
  (`apps/frontend/patches/braces@3.0.3.patch`: nesting capped at 100, cyclic parent chains
  rejected), covered by `apps/frontend/scripts/test-advisory-remediation.cjs`. OSV still reports
  3.0.3 because it cannot see pnpm patches. For the frontend, this supersedes the 2026-10-04 note
  that a local patch was unnecessary.
- The docs and contracts copies remain unpatched. Their reachability is unchanged from
  `audit/dependency-review-2026-10-04.md`: patterns come only from repository-owned build, watch
  and test configuration, and nothing deployed accepts a user-supplied glob.

The contracts baseline keeps the same exact fingerprint and severity ceilings; only its review
note moves to the new date. Remove both dated ignores and the contracts fingerprint when a
compatible fixed release ships or the advisory is withdrawn. Reassess immediately if a runtime
import, user-configurable glob API or hosted build/watch service appears.

## Dependency floors

| Change | Reason |
| --- | --- |
| Root override `@modelcontextprotocol/sdk` `^1.30.0` to `^1.31.0`; `apps/mcp-server` dependency `^1.29.0` to `^1.31.0` | GHSA-6qxp-vccf-f47h is fixed in 1.31.0. The old floors admitted the vulnerable 1.30.x on any re-resolution. The lockfile stays on 1.32.1. |
| Root override `pbkdf2` added at `^3.1.7`; frontend override `^3.1.3` to `^3.1.7` | GHSA-477h-4r7f-fvrx (moderate) is fixed in 3.1.7 (published 2026-09-29, past the frontend 7-day soak). #1542 fixed only contracts; root still resolved 3.1.6 and the frontend 3.1.5. |
| Root `fastify` override line re-indented | Formatting slip from #1542; the value is unchanged. |

pbkdf2 sits behind crypto-browserify, parse-asn1 and ethereum-cryptography: dev/test toolchains
at the root and, in the frontend, browser crypto polyfills fed by the local user's own input. This
is hygiene, not an incident fix; neither gate blocks on a moderate finding.

## Lockfile regeneration

Both lockfiles were regenerated with `pnpm install --lockfile-only` (root pnpm 9.12.0, frontend
pnpm 10.30.3). Changing a frontend override re-resolves the whole tree, which re-trips the soak on
three versions already pinned by earlier security PRs: http-cache-semantics 4.3.0, source-map-js
1.2.2 and shell-quote 1.12.0. Following the procedure documented in
`apps/frontend/pnpm-workspace.yaml`, those three names were excluded for the one regeneration and
removed again. The committed `pnpm-workspace.yaml` is unchanged, the three pins did not move, and
the only lockfile changes are the pbkdf2 and SDK-specifier lines.
