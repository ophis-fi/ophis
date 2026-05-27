# docs-ophis

The Ophis documentation portal, [docs.ophis.fi](https://docs.ophis.fi).
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

- `apps/frontend/apps/cowswap-frontend/public/openapi.yaml`. Intent API spec
- `apps/frontend/apps/cowswap-frontend/public/llms.txt`, agent-facing summary
- `functions/api/intent.ts`, the live parser behaviour (model, limits)

When those change, update the corresponding page here.

## Deployment

Shipped to a **dedicated Cloudflare Pages project** (`ophis-docs`),
separate from the main app's `greg` project, by
`.github/workflows/docs-deploy.yml` on pushes to `main` that touch
`apps/docs-ophis/**`. The `docs.ophis.fi` custom domain points at this
project. The historical static shim that previously served `/docs` from
the main app, a `public/docs/` mirror plus a `_middleware.ts` rewrite , 
was retired once this portal went live; `_middleware.ts` now just 301s
apex `/docs*` here.
