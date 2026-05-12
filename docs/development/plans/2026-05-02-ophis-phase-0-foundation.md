# Ophis Phase 0 — Foundation Implementation Plan


**Goal:** Stand up the `ophis-fi/ophis` monorepo, vendor `cowprotocol/cowswap` and `cowprotocol/services` as subtrees, deploy a minimally-rebranded frontend to Vercel, and complete one real swap on Gnosis Chiado testnet via the Ophis frontend hitting CoW's official APIs.

**Architecture:** pnpm + turbo monorepo. `apps/frontend/` = subtree of `cowprotocol/cowswap` (kept on its native package manager — yarn or pnpm — to avoid breaking the upstream toolchain). `apps/backend/` = subtree of `cowprotocol/services` (Rust/cargo, builds independently). `packages/sdk/` = thin TS wrapper around `cow-sdk`. `agents/` defines `pm`, `frontend`, `backend`, `cto` roles. CI on GitHub Actions. Frontend deployed to Vercel; backend stays local in Phase 0 (Aleph deploy lands in Phase 1).

**Tech Stack:** pnpm, turbo, TypeScript, GitHub Actions, gh CLI, git subtree, Vercel CLI, yarn/pnpm (whichever cowswap uses), cargo, cow-sdk (Apache-2.0), Gnosis Chiado testnet, Safe testnet faucet.

**Spec:** [`docs/development/specs/2026-05-02-ophis-design.md`](../specs/2026-05-02-ophis-design.md)

**Phase gate:** A test wallet completes a swap on Gnosis Chiado, signed via the Ophis-branded frontend, settled by CoW's solver network on Chiado, and a one-page validation log is committed to `docs/development/phase-0-validation.md`.

---

## File Structure (created by this plan)

| Path | Owner | Purpose |
|---|---|---|
| `package.json` | root | pnpm workspace root, turbo scripts |
| `pnpm-workspace.yaml` | root | workspace package list (excludes `apps/frontend` if it ships its own pkg manager) |
| `turbo.json` | root | turbo task pipeline |
| `tsconfig.base.json` | root | shared TS settings |
| `.gitignore` | root | node/build/IDE exclusions |
| `.editorconfig`, `.nvmrc` | root | editor/runtime hygiene |
| `LICENSE` | root | GPL-3.0 (required by upstream) |
| `README.md` | root | one-paragraph project description, links to spec |
| `.eslintrc.cjs`, `.prettierrc` | root | shared lint/format config (skipped inside `apps/frontend` which has its own) |
| `.github/workflows/ci.yml` | root | lint + typecheck + frontend build |
| `agents/cto.md` | root | CTO operating mode (documentation, not a Task subagent) |
| `agents/pm.md` | root | PM agent definition |
| `agents/frontend.md` | root | Frontend agent definition |
| `agents/backend.md` | root | Backend agent definition |
| `apps/frontend/` | subtree | `cowprotocol/cowswap` vendored via `git subtree add` |
| `apps/backend/` | subtree | `cowprotocol/services` vendored via `git subtree add` |
| `packages/sdk/package.json` | new | `@greg/sdk` package metadata |
| `packages/sdk/src/index.ts` | new | thin wrapper around `@cowprotocol/cow-sdk` exporting Ophis defaults (chain, partner fee) |
| `packages/sdk/tsconfig.json` | new | extends `tsconfig.base.json` |
| `packages/sdk/tests/sdk.test.ts` | new | unit test verifying default config |
| `infra/rpc/fallback.ts` | new | `viem` fallback transport config (Alchemy → PublicNode → Ankr) for Gnosis |
| `docs/development/phase-0-validation.md` | new | phase-gate evidence log |

---

## Dispatch hints (for sub-agent runs)

- **Tasks 1–4, 13:** CTO (main session) — repo bootstrapping & GitHub.
- **Tasks 5–8:** `frontend` agent — cowswap subtree, build, rebrand, Vercel.
- **Tasks 9–10:** `backend` agent — services subtree, cargo build.
- **Task 11:** `frontend` agent — SDK wrapper.
- **Task 12:** PM agent — drive the manual Chiado swap and write the validation log.

Tasks 5–8 and 9–10 can run in parallel (independent paths, no shared files).

---

## Task 1: Monorepo skeleton + tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE`, `README.md`, `.eslintrc.cjs`, `.prettierrc`

- [ ] **Step 1: Verify Node + pnpm**

```bash
node --version   # expect ≥ v20
pnpm --version   # expect ≥ 9; install with `npm i -g pnpm` if missing
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "greg",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "format": "prettier -w \"**/*.{ts,tsx,js,jsx,json,md,yml,yaml}\" --ignore-path .gitignore"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.5.0",
    "prettier": "^3.3.0",
    "eslint": "^9.10.0",
    "@types/node": "^22.5.0"
  }
}
```

- [ ] **Step 3: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/backend"
# apps/frontend is excluded — cowswap upstream ships its own package manager
```

- [ ] **Step 4: Write `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "lint": {},
    "test": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 5: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 6: Write `.gitignore`**

```gitignore
node_modules/
dist/
.next/
.turbo/
.vercel/
target/
.env
.env.local
.env.*.local
.DS_Store
*.log
coverage/
.idea/
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
```

- [ ] **Step 7: Write `.editorconfig` and `.nvmrc`**

`.editorconfig`:
```ini
root = true
[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
```

`.nvmrc`:
```
20
```

- [ ] **Step 8: Fetch `LICENSE` (GPL-3.0)**

```bash
curl -fsSL https://www.gnu.org/licenses/gpl-3.0.txt -o LICENSE
head -3 LICENSE
```
Expected: first line is `                    GNU GENERAL PUBLIC LICENSE`.

- [ ] **Step 9: Write `README.md` skeleton**

```markdown
# Ophis

Stage-2 fork of [CoW Protocol](https://docs.cow.fi) on Gnosis Chain, targeting DeFi power-user retail.

- Spec: [`docs/development/specs/2026-05-02-ophis-design.md`](docs/development/specs/2026-05-02-ophis-design.md)
- Phase 0 plan: [`docs/development/plans/2026-05-02-ophis-phase-0-foundation.md`](docs/development/plans/2026-05-02-ophis-phase-0-foundation.md)

License: GPL-3.0. Codename `greg`; rebrand TBD before public launch.
```

- [ ] **Step 10: Write `.eslintrc.cjs` and `.prettierrc`**

`.eslintrc.cjs`:
```js
module.exports = {
  root: true,
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  ignorePatterns: ['node_modules/', 'dist/', 'apps/frontend/**', 'apps/backend/**'],
};
```

`.prettierrc`:
```json
{ "singleQuote": true, "semi": true, "trailingComma": "all", "printWidth": 100 }
```

- [ ] **Step 11: Install and verify**

```bash
pnpm install
pnpm typecheck   # noop until packages exist; should print "No tasks were executed"
```
Expected: `pnpm install` completes without errors. `pnpm typecheck` finishes cleanly.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: monorepo skeleton (pnpm + turbo + tsconfig + GPL-3.0)"
```

---

## Task 2: `agents/` role definitions

**Files:**
- Create: `agents/cto.md`, `agents/pm.md`, `agents/frontend.md`, `agents/backend.md`

- [ ] **Step 1: Write `agents/cto.md`** (documentation, not a Task subagent)

```markdown
# CTO (operating mode)

Not a dispatched subagent — this file documents the operating mode for the
main operator session driving the project.

**Responsibilities**
- Cross-cutting architectural decisions
- Dispatching `pm`, `frontend`, `backend` agents via the Task tool when work fits
- Final sign-off on phase gates
- Spec and plan ownership

**When to dispatch agents**
- Independent FE + BE work in parallel → dispatch both at once
- Status sweeps, GitHub issue grooming → `pm`
- Anything inside `apps/frontend/` → `frontend`
- Anything inside `apps/backend/` → `backend`

**Rules**
- Never edit code that an agent's brief says is theirs without notifying.
- Cross-package refactors: CTO writes the diff, both agents review.
```

- [ ] **Step 2: Write `agents/pm.md`**

````markdown
---
name: pm
description: Project manager for Ophis. Tracks roadmap, grooms the backlog, writes status sweeps, opens/labels GitHub issues. Read-only on code.
tools: Read, Grep, Glob, Bash, WebFetch, TaskCreate, TaskUpdate
---

You are the project manager for **Ophis**, a Stage-2 CoW Protocol fork. Your
job is to keep the roadmap visible and the backlog clean. You do **not**
write code or modify files outside `docs/`.

## Authoritative documents
- Spec: `docs/development/specs/2026-05-02-ophis-design.md`
- Active plan(s): `docs/development/plans/`

## What you do
- Read the latest plan and report progress against checkboxes.
- Open and label GitHub issues from open plan tasks (`gh issue create`).
- Write weekly status sweeps to `docs/development/status/YYYY-MM-DD.md`.
- Detect drift between spec and code; flag, do not fix.

## Hard rules
- Bash is read-only: `git`, `gh`, `ls`, `cat` allowed; never `rm`, never write.
- Never edit `apps/`, `packages/`, `infra/`. Only `docs/`.
- Never make architectural decisions; surface options to the CTO.
````

- [ ] **Step 3: Write `agents/frontend.md`**

````markdown
---
name: frontend
description: Frontend engineer for Ophis. Owns apps/frontend (cowswap subtree), packages/sdk, and Vercel deploys. React/TypeScript/Next.js. Does not touch apps/backend.
tools: Read, Edit, Write, Bash, Grep, Glob, WebFetch
---

You are the senior frontend engineer for **Ophis**. You own the cowswap fork,
the SDK wrapper, and Vercel deployments.

## Scope
- `apps/frontend/` — vendored fork of `cowprotocol/cowswap`. Modify carefully;
  preserve subtree-merge compatibility with upstream where reasonable.
- `packages/sdk/` — `@greg/sdk`, thin wrapper around `@cowprotocol/cow-sdk`.
- `infra/rpc/` — RPC fallback config consumed by FE.
- Vercel deploys (`vercel` CLI).

## Out of scope
- `apps/backend/` (Rust services) — that's the backend agent's territory.
- Spec-level decisions — escalate to CTO.

## Skills to invoke when relevant
- `vercel:nextjs`, `vercel:deployments-cicd`, `vercel:env-vars`
- `frontend-design`, `web-design-guidelines`, `vercel:react-best-practices`
- `ethskills` for any chain/contract interaction question

## House rules
- TDD where it makes sense. Vitest for units, Playwright for E2E.
- Never bypass `git` hooks. Never `--force` push without a written reason.
- Vendored code has its own conventions — match upstream cowswap style inside
  `apps/frontend/`; match Ophis style elsewhere.
- Use `git subtree pull --prefix=apps/frontend cowswap-upstream main --squash`
  to track upstream updates; never rewrite the subtree directory's git history.
````

- [ ] **Step 4: Write `agents/backend.md`**

````markdown
---
name: backend
description: Backend engineer for Ophis. Owns apps/backend (cowprotocol/services subtree, Rust). Postgres schemas, Aleph deploys (Phase 1+). Does not touch apps/frontend.
tools: Read, Edit, Write, Bash, Grep, Glob, WebFetch
---

You are the senior backend engineer for **Ophis**. You own the
`cowprotocol/services` fork — orderbook API, auction driver, solver
integration — and (from Phase 1) the Aleph Cloud deployments.

## Scope
- `apps/backend/` — Rust workspace, vendored from `cowprotocol/services`.
- `infra/aleph/` — Aleph deploy manifests (Phase 1+).
- Postgres schemas for orderbook persistence.

## Out of scope
- `apps/frontend/` — frontend agent's territory.
- Settlement contracts (we use CoW's audited Gnosis deployment).

## Skills to invoke when relevant
- `ethskills` for chain semantics, RPC, and contract calls
- `building-secure-contracts:*` if/when a custom contract is added
- `testing-handbook-skills:*` for fuzzing & coverage
- `dimensional-analysis:*` for token-amount/decimal hygiene

## House rules
- Match upstream `cowprotocol/services` Rust conventions inside `apps/backend/`.
  When in doubt, run `cargo fmt` and `cargo clippy --workspace -- -D warnings`.
- Never bypass `git` hooks. Never `--force` push without a written reason.
- Track upstream with `git subtree pull --prefix=apps/backend services-upstream main --squash`.
- TDD via `cargo test` for unit; integration tests against `anvil` forked from Gnosis.
````

- [ ] **Step 5: Verify frontmatter is valid**

```bash
ls agents/
head -5 agents/pm.md
head -5 agents/frontend.md
head -5 agents/backend.md
```
Expected: all four files exist; `pm`, `frontend`, `backend` each start with a `---` frontmatter block.

- [ ] **Step 6: Commit**

```bash
git add agents/
git commit -m "chore: define CTO/PM/frontend/backend agent roles"
```

---

## Task 3: GitHub Actions CI scaffolding

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: {}

jobs:
  root:
    name: root (lint + typecheck)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint || echo "no lint targets yet"
      - run: pnpm typecheck || echo "no typecheck targets yet"

  sdk:
    name: packages/sdk
    runs-on: ubuntu-latest
    needs: root
    if: hashFiles('packages/sdk/package.json') != ''
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @greg/sdk test
```

(Note: the `frontend` and `backend` jobs are deliberately omitted from this file — they ship in Phase 1 once those subtrees actually build cleanly inside CI. Adding them now produces red builds on day 1.)

- [ ] **Step 2: Commit**

```bash
git add .github/
git commit -m "ci: add root + sdk workflow (frontend/backend jobs deferred)"
```

---

## Task 4: Create the GitHub repo and push

**Files:** none modified.

- [ ] **Step 1: Verify gh auth**

```bash
gh auth status
```
Expected: `Logged in to github.com as san-npm` (or equivalent active account).

- [ ] **Step 2: Create the private repo**

```bash
gh repo create ophis-fi/ophis \
  --private \
  --source=. \
  --remote=origin \
  --description="Stage-2 CowSwap fork — Gnosis-first, retail power-user. Codename greg." \
  --push
```
Expected: repo created and initial commit pushed.

- [ ] **Step 3: Verify**

```bash
gh repo view ophis-fi/ophis --json name,visibility,defaultBranchRef
git remote -v
```
Expected: `visibility: PRIVATE`, default branch `main`, `origin` set to `git@github.com:ophis-fi/ophis.git` (or HTTPS).

- [ ] **Step 4: Confirm CI runs**

```bash
gh run list --limit 5
```
Expected: a `CI` run from the latest push (status may be in_progress or completed).

---

## Task 5: Subtree-merge `cowprotocol/cowswap` into `apps/frontend/`

**Files:**
- Create: `apps/frontend/` (entire subtree).

- [ ] **Step 1: Add upstream remote**

```bash
git remote add cowswap-upstream https://github.com/cowprotocol/cowswap.git
git fetch cowswap-upstream main
git remote -v
```

- [ ] **Step 2: Subtree-add the upstream into `apps/frontend/`**

```bash
git subtree add --prefix=apps/frontend cowswap-upstream main --squash
```
Expected: a merge commit named "Add 'apps/frontend/' from commit '<sha>'".

- [ ] **Step 3: Sanity-check the subtree**

```bash
ls apps/frontend/
test -f apps/frontend/package.json && echo "OK: cowswap package.json present"
```
Expected: cowswap source tree visible; `package.json` exists.

- [ ] **Step 4: Record the upstream SHA pin**

Append to `apps/frontend/.greg-upstream` (new file):

```bash
git -C "$(pwd)" log -1 cowswap-upstream/main --format='%H %s' > apps/frontend/.greg-upstream
cat apps/frontend/.greg-upstream
git add apps/frontend/.greg-upstream
git commit -m "chore(frontend): pin upstream cowswap commit"
```

---

## Task 6: Get the cowswap fork building locally

**Files:**
- Modify: `pnpm-workspace.yaml` if cowswap turns out to use pnpm too; otherwise no edits.
- Create: `apps/frontend/.greg-build-notes.md` (one-paragraph build provenance).

- [ ] **Step 1: Detect upstream package manager**

```bash
test -f apps/frontend/pnpm-lock.yaml && echo pnpm
test -f apps/frontend/yarn.lock && echo yarn
test -f apps/frontend/package-lock.json && echo npm
cat apps/frontend/package.json | grep -E '"packageManager"|"workspaces"' || true
```
Decide: if pnpm, **add** `apps/frontend` and any nested workspace globs to root `pnpm-workspace.yaml`. If yarn or npm, leave excluded and run install/build inside `apps/frontend/` with that tool.

- [ ] **Step 2: Install upstream's deps**

If pnpm:
```bash
pnpm install
```
If yarn:
```bash
( cd apps/frontend && corepack enable && yarn install --immutable )
```
If npm:
```bash
( cd apps/frontend && npm ci )
```
Expected: install completes without unresolved errors. Network/resolution failures must be fixed before continuing — do not skip.

- [ ] **Step 3: Run upstream build**

```bash
( cd apps/frontend && cat package.json | grep -E '"build"' )
```
Then run whichever of `pnpm build`, `yarn build`, or `npm run build` matches the package manager from Step 1, scoped to the cowswap workspace.

Expected: build succeeds. Note any required Node version, env vars, or manual steps in the build notes file.

- [ ] **Step 4: Document the build path**

Write `apps/frontend/.greg-build-notes.md`:

```markdown
# apps/frontend build notes

Upstream: cowprotocol/cowswap (see `.greg-upstream` for pinned SHA).
Package manager: <pnpm|yarn|npm — fill in>.
Local build: `<exact command from Step 3>`.
Required env vars (if any): <list, or "none">.
Known gotchas: <list, or "none discovered">.
```

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/.greg-build-notes.md pnpm-workspace.yaml 2>/dev/null
git commit -m "build(frontend): document local build path for cowswap subtree" || true
```

---

## Task 7: Minimal Ophis rebrand

**Files:**
- Modify: a small set of cowswap branding files (visible name, title, manifest). Exact paths are determined by inspection in Step 1 — do **not** rename source files, do **not** change CSS/visual design.

- [ ] **Step 1: Locate user-facing branding strings**

```bash
( cd apps/frontend && grep -RIn --include='*.json' --include='*.html' --include='*.tsx' --include='*.ts' \
   -E 'CoW Swap|CowSwap|cowswap.fi|"name":[[:space:]]*"CoW' . | head -50 )
```
Make a short list of files to touch. Target: app title, HTML `<title>`, web manifest `name` and `short_name`, and the visible header brand text. **Do not** modify business logic, hooks, or contract addresses.

- [ ] **Step 2: Patch the brand text to "Ophis"**

Use targeted edits, one file at a time. Examples (paths may differ in actual cowswap):

- `apps/frontend/apps/cowswap-frontend/public/manifest.json` — set `"name": "Ophis"`, `"short_name": "Ophis"`.
- `apps/frontend/apps/cowswap-frontend/index.html` — set `<title>Ophis</title>`.
- Any header component rendering "CoW Swap" → render "Ophis".

For each file: open, change only the text, save.

- [ ] **Step 3: Run the local dev server and eyeball it**

Run cowswap's dev command (whatever Step 3 of Task 6 surfaced — typically `yarn start` or `pnpm dev`) and open the local URL. Verify that:

- The window title says "Ophis".
- The header brand text says "Ophis".
- The PWA manifest shows "Ophis".
- Nothing else changed (swap form, network selector, addresses still cowswap-vanilla).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/
git commit -m "feat(frontend): minimal text rebrand to Ophis (no visual redesign)"
```

---

## Task 8: Deploy frontend to Vercel

**Files:**
- Create (auto-generated by `vercel link`): `apps/frontend/.vercel/project.json` — **do not commit** (already in `.gitignore` via `.vercel/`).
- Create (manual): `apps/frontend/vercel.json` if cowswap doesn't already ship one.

- [ ] **Step 1: Verify Vercel CLI auth**

```bash
vercel whoami
```
Expected: `clementfrmds-projects` (or active account).

- [ ] **Step 2: Link the project**

```bash
( cd apps/frontend && vercel link --project greg-frontend --yes )
```
Expected: creates the Vercel project on first run, writes `.vercel/project.json`.

- [ ] **Step 3: Configure Vercel build for the subdirectory**

If cowswap requires a non-default build command/output directory (it does — it's a yarn workspaces monorepo internally), create `apps/frontend/vercel.json`:

```json
{
  "buildCommand": "<exact command from build notes>",
  "outputDirectory": "<exact output dir from cowswap upstream>",
  "framework": null,
  "installCommand": "<exact install command from build notes>"
}
```
Fill the placeholders from `apps/frontend/.greg-build-notes.md`. If cowswap's docs specify a Vercel template, prefer that.

- [ ] **Step 4: Pull env (none expected for pure frontend, but verify)**

```bash
( cd apps/frontend && vercel env pull .env.local )
ls -la apps/frontend/.env.local 2>/dev/null
```
Expected: empty or near-empty file. Keys come later (Phase 1) when backend env exists.

- [ ] **Step 5: Deploy a preview**

```bash
( cd apps/frontend && vercel )
```
Expected: a preview URL is printed. Open it, verify it loads with Ophis branding.

- [ ] **Step 6: Commit `vercel.json` (only)**

```bash
git add apps/frontend/vercel.json
git commit -m "deploy(frontend): vercel build config" || true
```

---

## Task 9: Subtree-merge `cowprotocol/services` into `apps/backend/`

**Files:**
- Create: `apps/backend/` (entire subtree).

- [ ] **Step 1: Add upstream remote**

```bash
git remote add services-upstream https://github.com/cowprotocol/services.git
git fetch services-upstream main
```

- [ ] **Step 2: Subtree-add**

```bash
git subtree add --prefix=apps/backend services-upstream main --squash
```

- [ ] **Step 3: Pin upstream SHA**

```bash
git log -1 services-upstream/main --format='%H %s' > apps/backend/.greg-upstream
git add apps/backend/.greg-upstream
git commit -m "chore(backend): pin upstream services commit"
```

---

## Task 10: Get the services fork building locally

**Files:**
- Create: `apps/backend/.greg-build-notes.md`.

- [ ] **Step 1: Verify Rust toolchain**

```bash
rustup --version
cargo --version
rustc --version
```
If missing: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`. Use the toolchain version pinned in `apps/backend/rust-toolchain.toml` (read it first).

- [ ] **Step 2: Read upstream README**

```bash
head -200 apps/backend/README.md
```
Note any system prerequisites (Postgres client libs, OpenSSL, protoc, etc.).

- [ ] **Step 3: Build**

```bash
( cd apps/backend && cargo build --workspace )
```
Expected: builds. If a system dep is missing, install via Homebrew, document in build notes, retry.

- [ ] **Step 4: Run upstream tests**

```bash
( cd apps/backend && cargo test --workspace --lib )
```
Expected: green (or pre-existing failures clearly upstream-unrelated to our changes — we made none yet).

- [ ] **Step 5: Document**

Write `apps/backend/.greg-build-notes.md`:

```markdown
# apps/backend build notes

Upstream: cowprotocol/services (see `.greg-upstream` for pinned SHA).
Toolchain: <from rust-toolchain.toml>.
System deps: <list>.
Local build: `cargo build --workspace`.
Local tests: `cargo test --workspace --lib`.
Known gotchas: <list>.
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/.greg-build-notes.md
git commit -m "build(backend): document local build path for services subtree"
```

---

## Task 11: `@greg/sdk` wrapper package (TDD)

**Files:**
- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/src/index.ts`, `packages/sdk/src/config.ts`, `packages/sdk/tests/sdk.test.ts`, `packages/sdk/vitest.config.ts`.

- [ ] **Step 1: Write the failing test**

`packages/sdk/tests/sdk.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { gregDefaults, OPHIS_PARTNER_FEE_BPS, OPHIS_PARTNER_RECIPIENT } from '@greg/sdk';

describe('@greg/sdk defaults', () => {
  it('targets Gnosis Chain (chainId 100)', () => {
    expect(gregDefaults.chainId).toBe(100);
  });

  it('exposes a partner-fee config matching the spec default of 5 bps', () => {
    expect(OPHIS_PARTNER_FEE_BPS).toBe(5);
  });

  it('has a placeholder partner-fee recipient that callers must override', () => {
    expect(OPHIS_PARTNER_RECIPIENT).toMatch(/^0x0{40}$/);
  });
});
```

- [ ] **Step 2: Write package metadata**

`packages/sdk/package.json`:
```json
{
  "name": "@greg/sdk",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

`packages/sdk/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*", "tests/**/*"]
}
```

`packages/sdk/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm install
pnpm --filter @greg/sdk test
```
Expected: fails with "Cannot find module '@greg/sdk'" or unresolved imports.

- [ ] **Step 4: Implement minimal SDK surface**

`packages/sdk/src/config.ts`:
```typescript
export const OPHIS_CHAIN_IDS = { gnosis: 100 } as const;

export const OPHIS_PARTNER_FEE_BPS = 5;
export const OPHIS_PARTNER_RECIPIENT =
  '0x0000000000000000000000000000000000000000' as const;

export interface GregDefaults {
  readonly chainId: number;
  readonly partnerFeeBps: number;
  readonly partnerRecipient: `0x${string}`;
}

export const gregDefaults: GregDefaults = {
  chainId: OPHIS_CHAIN_IDS.gnosis,
  partnerFeeBps: OPHIS_PARTNER_FEE_BPS,
  partnerRecipient: OPHIS_PARTNER_RECIPIENT,
};
```

`packages/sdk/src/index.ts`:
```typescript
export {
  gregDefaults,
  OPHIS_CHAIN_IDS,
  OPHIS_PARTNER_FEE_BPS,
  OPHIS_PARTNER_RECIPIENT,
  type GregDefaults,
} from './config.js';
```

- [ ] **Step 5: Run tests to verify pass**

```bash
pnpm --filter @greg/sdk test
```
Expected: 3 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/
git commit -m "feat(sdk): @greg/sdk minimal wrapper with Gnosis defaults + 5bps partner fee"
```

---

## Task 12: Phase-0 gate — manual Chiado swap & validation log

**Files:**
- Create: `docs/development/phase-0-validation.md`.

This is a manual milestone. The task is to **execute** the swap end-to-end, not to write Playwright now (E2E automation lands in Phase 2).

- [ ] **Step 1: Generate / pick a test wallet**

```bash
cast wallet new
```
Save the address and key in macOS Keychain under entry `ophis-chiado-test`. Never commit the key.

- [ ] **Step 2: Fund on Chiado testnet**

Use https://gnosisfaucet.com/ → select **Chiado** → request native xDAI. For ERC-20s, swap-in via Chiado's documented routes (the upstream cowswap docs list test pairs).

- [ ] **Step 3: Deploy a Vercel preview against the cowswap-default API endpoint**

Confirm the cowswap fork's default network selector exposes Chiado. If not, either (a) flip the default network env via `vercel env`, or (b) defer the test to Gnosis mainnet with a $5 ceiling — note which path was taken in the validation log.

- [ ] **Step 4: Execute one swap**

Open the Vercel preview, connect the test wallet, place a small swap (e.g., 0.001 native ↔ a Chiado test token). Sign. Wait for settlement.

- [ ] **Step 5: Capture proof**

Record:
- Vercel preview URL
- Wallet address
- Order UID (visible in cowswap UI after signing)
- Settlement tx hash
- Block explorer link (`https://blockscout.com/xdai/chiado/tx/<hash>` or current Chiado explorer)

- [ ] **Step 6: Write the validation log**

`docs/development/phase-0-validation.md`:

```markdown
# Phase 0 — Validation Log

**Date:** <YYYY-MM-DD>
**Operator:** <name>

## Setup
- Repo: ophis-fi/ophis, commit `<sha>`
- Vercel preview: <url>
- Backend: CoW official Chiado/Gnosis API (no self-hosted backend in Phase 0)

## Test wallet
- Address: <0x...>
- Funded via: <faucet url>

## Swap
- Network: <Chiado | Gnosis mainnet, with reason if not Chiado>
- Pair: <TOKEN_IN → TOKEN_OUT>
- Amount in: <...>
- Order UID: <0x...>
- Settlement tx: <0x...>
- Explorer: <url>
- Time-to-settle: <seconds>

## Branding sanity
- Window title shows "Ophis": yes/no
- Manifest name "Ophis": yes/no
- No accidental cowswap.fi links in user-visible UI: yes/no

## Issues encountered
<bulleted list, or "none">

## Phase-0 gate: PASS / FAIL
<one-line verdict>
```

- [ ] **Step 7: Commit**

```bash
git add docs/development/phase-0-validation.md
git commit -m "docs: phase-0 validation log — first Ophis swap on Chiado"
git push
```

---

## Task 13: Close out Phase 0

**Files:** none modified.

- [ ] **Step 1: Open a Phase-1 tracking issue**

```bash
gh issue create --title "Phase 1: self-hosted backend on Aleph" \
  --body "Tracking issue for Phase 1 deliverables. Plan: docs/development/plans/<phase-1>.md (TBD)" \
  --label phase-1
```

- [ ] **Step 2: Tag a v0.0-phase0**

```bash
git tag -a v0.0-phase0 -m "Phase 0 foundation complete"
git push --tags
```

- [ ] **Step 3: Status sweep**

Dispatch the `pm` agent to write `docs/development/status/<date>.md` summarizing Phase 0 outcomes and Phase 1 readiness.

---

## Self-Review Notes (from author)

- **Spec coverage:** every Phase-0 spec bullet (monorepo, frontend fork, backend fork, Vercel deploy, frontend → CoW API, Chiado phase gate) maps to a task above. Sub-agent definitions land in Task 2; CI in Task 3; SDK in Task 11; Vercel + branding in Tasks 7–8.
- **Placeholders:** none. The few `<fill in>` spots are *runtime values* (commit SHAs, wallet addresses, tx hashes) that can only be filled when the task runs, not plan-author placeholders.
- **Type consistency:** `OPHIS_PARTNER_FEE_BPS` / `OPHIS_PARTNER_RECIPIENT` / `gregDefaults` consistent across Task 11. No FE→BE name overlap.
- **Risk:** Tasks 6, 8, 10 contain inspection-then-decide steps because cowswap's exact build/deploy contract isn't reproduced in the brief — the engineer must read upstream first. This is correct: hard-coding paths would lie about what we know.
