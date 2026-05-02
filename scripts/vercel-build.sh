#!/bin/bash
set -e

# Vercel uploads source files without git history.
# The vite config calls `git rev-parse` and `git show` at build time.
# Seed a minimal git repo so those commands return something sensible.
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  git init -q
  git config user.email "build@vercel.app"
  git config user.name "Vercel Build"
  git add -A
  git commit -q -m "vercel build snapshot"
fi

cd apps/frontend

# Remove tiny-secp256k1 from onlyBuiltDependencies so its native addon
# (which fails to compile on Vercel's build runners) is skipped.
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.pnpm.onlyBuiltDependencies = p.pnpm.onlyBuiltDependencies.filter(x => x !== 'tiny-secp256k1');
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
"
pnpm install --frozen-lockfile
pnpm run build:cowswap
