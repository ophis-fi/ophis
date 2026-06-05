# Verifying a deployed Ophis frontend (build provenance) — #438

Each frontend deploy (`swap.ophis.fi`, `explorer.ophis.fi`, `docs.ophis.fi`,
`ophis.fi`) publishes a **SLSA build-provenance attestation** signed by GitHub
Actions OIDC. The attest step uses `subject-checksums` over a `sha256sum`
manifest, so **every static file in the bundle is recorded as its own
attestation subject** (by digest). You therefore do NOT need the manifest to
verify: any single deployed file can be checked directly.

This lets anyone confirm the live site was built from a specific commit by the
repo's workflow, with nothing altered between source and edge.

## What is attested (and what is not)

| Surface | Workflow | Static dir attested |
|---|---|---|
| swap + explorer | `cloudflare-deploy.yml` | `apps/frontend/build/cowswap` (minus `functions/`), `apps/frontend/build/explorer` |
| docs | `docs-deploy.yml` | `$RUNNER_TEMP/docs-dist/build` |
| landing | `landing-deploy.yml` | `apps/frontend/apps/ophis-landing/dist` (minus `functions/`) |

The attest step runs **after** `pages deploy`, so a provenance failure can never
block a release.

**NOT attested: Cloudflare Pages Functions** (`/api/intent`). CF compiles the
`functions/` TypeScript into a worker server-side at deploy, so the deployed
worker bytes are not files we ship verbatim — `functions/` is excluded from the
manifests. The function *source* lives in the repo (`functions/api/intent.ts`)
and is covered by normal git/commit provenance, just not by this deployed-byte
attestation.

## Verify a deployed file (no manifest needed)

```bash
# Download any asset the live site serves, then verify it against the attestation:
curl -sO https://swap.ophis.fi/emergency.js
gh attestation verify emergency.js --repo ophis-fi/ophis
```

`gh attestation verify` confirms the file's sha256 matches an attestation
subject produced by an `ophis-fi/ophis` GitHub Actions workflow (it checks the
OIDC signer identity). Repeat for any file on any surface.

## Reproduce + match the live bundle (end-to-end)

1. Check out the attested commit and build with the pinned toolchain, **from the
   app workspace** (these scripts do not exist at the repo root —
   `pnpm-workspace.yaml` excludes `apps/frontend`):
   ```bash
   git checkout <commit>
   corepack enable
   pnpm install --frozen-lockfile
   pnpm -C apps/frontend run build:cowswap        # swap + explorer (also: pnpm -C apps/frontend exec nx run explorer:build)
   pnpm -C apps/docs-ophis run build              # docs
   pnpm -C apps/frontend --filter @ophis/landing build   # landing
   ```
2. Recompute a file's hash and compare, or just re-verify the built file:
   ```bash
   sha256sum apps/frontend/build/cowswap/emergency.js
   gh attestation verify apps/frontend/build/cowswap/emergency.js --repo ophis-fi/ophis
   ```

> Caveat: full byte-for-byte reproducibility across machines is not yet
> guaranteed (toolchain/OS nondeterminism is unproven — Phase 4 of #438). Until
> then, the attestation proves *provenance* (who/what/which-commit built it);
> bit-exact reproduction is best-effort.
