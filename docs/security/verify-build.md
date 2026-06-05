# Verifying a deployed Ophis frontend (build provenance) — #438

Each frontend deploy (`swap.ophis.fi`, `explorer.ophis.fi`, `docs.ophis.fi`,
`ophis.fi`) publishes a **SLSA build-provenance attestation** signed by GitHub
Actions OIDC. The attestation's subject is a `*-bundle-manifest.txt` that lists
the `sha256` of every file pushed to Cloudflare Pages, so the manifest hash
transitively commits to the entire deployed bundle.

This lets anyone confirm the live site was built from a specific commit by the
repo's workflow, with nothing altered between source and edge.

## What is attested

| Surface | Workflow | Deployed dir hashed into the manifest |
|---|---|---|
| swap + explorer | `cloudflare-deploy.yml` | `apps/frontend/build/cowswap`, `apps/frontend/build/explorer` |
| docs | `docs-deploy.yml` | `$RUNNER_TEMP/docs-dist/build` |
| landing | `landing-deploy.yml` | `apps/frontend/apps/ophis-landing/dist` |

The attest step runs **after** the `pages deploy` step, so a provenance failure
can never block a release.

## Verify a manifest produced by CI

List/inspect attestations for the repo:

```bash
gh attestation list --repo ophis-fi/ophis
# Verify a specific manifest artifact you obtained from a workflow run:
gh attestation verify <manifest.txt> --repo ophis-fi/ophis
```

`gh attestation verify` confirms the manifest was produced by an
`ophis-fi/ophis` GitHub Actions workflow (checks the OIDC signer identity).

## Reproduce + match the live bundle (end-to-end)

1. Check out the attested commit and use the pinned toolchain:
   ```bash
   git checkout <commit>
   corepack enable
   pnpm install --frozen-lockfile
   pnpm run build:cowswap          # or: pnpm run build (docs) / pnpm --filter @ophis/landing build
   ```
2. Recompute the manifest over the build output exactly as CI does:
   ```bash
   ( cd apps/frontend/build/cowswap && find . -type f -exec sha256sum {} \; | LC_ALL=C sort | sed 's# \./# swap/#' )
   # ...append explorer the same way for cloudflare-deploy
   ```
3. `gh attestation verify` the recomputed manifest. A match proves the deployed
   bytes correspond to this source at this commit.

> Caveat: full byte-for-byte reproducibility across machines is not yet
> guaranteed (toolchain/OS nondeterminism is unproven — Phase 4 of #438). Until
> then, the attestation proves *provenance* (who/what/which-commit built it);
> bit-exact reproduction is best-effort.
