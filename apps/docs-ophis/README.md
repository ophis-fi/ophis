# docs-ophis

The Ophis documentation portal — [docs.ophis.fi](https://docs.ophis.fi).
Built with [Docusaurus 3](https://docusaurus.io/) (docs-only mode, offline
search, Ophis cosmic brand theme).

This is a **self-contained app**: it has its own `package.json` and
lockfile and is deliberately excluded from the root pnpm workspace, the
same way `apps/frontend` is. Install and build from inside this directory.

## Develop

```sh
cd apps/docs-ophis
pnpm install
pnpm start          # dev server with hot reload
```

## Build

```sh
pnpm build          # static site -> ./build
pnpm serve          # serve the production build locally
```

A broken internal link or anchor **fails the build** (`onBrokenLinks:
'throw'`). Treat a green `pnpm build` as the content test suite.

## Content

Pages live in `docs/` as Markdown with frontmatter; ordering and
category grouping are defined in `sidebars.ts`. Content is sourced from
the canonical app assets:

- `apps/frontend/apps/cowswap-frontend/public/openapi.yaml` — Intent API spec
- `apps/frontend/apps/cowswap-frontend/public/llms.txt` — agent-facing summary
- `functions/api/intent.ts` — the live parser behaviour (model, limits)

When those change, update the corresponding page here.

## Deployment

Shipped to a **dedicated Cloudflare Pages project** (`ophis-docs`),
separate from the main app's `greg` project, by
`.github/workflows/docs-deploy.yml` on pushes to `main` that touch
`apps/docs-ophis/**`.

### One-time setup (operator)

1. **Create the Pages project** (the deploy step fails until it exists):
   ```sh
   pnpm dlx wrangler pages project create ophis-docs --production-branch main
   ```
2. **Point the domain at it.** In the Cloudflare dashboard, move the
   `docs.ophis.fi` custom domain from the `greg` project to `ophis-docs`.
   Do this off-hours — there is a brief window during DNS/cert
   propagation. The main app (`ophis.fi`) is unaffected.
3. **Post-swap cleanup (follow-up PR).** Once `docs.ophis.fi` serves this
   site, retire the old static shim in the `greg` project:
   - delete `apps/frontend/apps/cowswap-frontend/public/docs/`
   - remove the `docs.ophis.fi` entry from `functions/_middleware.ts`
     (keep the `business.ophis.fi` entry)

   Sequencing matters: do **not** remove the old shim before the domain
   swap, or `docs.ophis.fi` will 404 while it still points at `greg`.
