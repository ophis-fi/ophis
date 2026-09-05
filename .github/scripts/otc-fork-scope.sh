#!/usr/bin/env bash
set -euo pipefail

requires_fork() {
  [[ "${1:-}" == workflow_dispatch ]] || ! git diff --quiet HEAD^1 HEAD -- \
    apps/frontend .github scripts contracts .gitmodules
}

if [[ "${1:-}" == --self-test ]]; then
  test_dir=$(mktemp -d)
  trap 'rm -rf "$test_dir"' EXIT
  cd "$test_dir"
  git init --quiet
  git config user.email test@example.invalid
  git config user.name Test
  git commit --quiet --allow-empty -m baseline
  git commit --quiet --allow-empty -m unchanged
  if requires_fork pull_request; then exit 1; fi
  requires_fork workflow_dispatch
  for path in apps/frontend/example .github/example scripts/example contracts/foundry.toml contracts/test/otc-fork/example contracts/lib/example .gitmodules; do
    mkdir -p "$(dirname "$path")"
    touch "$path"
    git add "$path"
    git commit --quiet -m changed
    requires_fork pull_request
    git rm --quiet "$path"
    git commit --quiet -m deleted
    requires_fork pull_request
  done
  touch README.md
  git add README.md
  git commit --quiet -m documentation
  if requires_fork pull_request; then exit 1; fi
  echo 'OTC fork scope checks passed'
elif requires_fork "${1:-}"; then
  echo 'required=true'
else
  echo 'required=false'
fi
