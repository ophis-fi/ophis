#!/usr/bin/env bash
# Exercise the actual release script without a Docker daemon, network or host mutations.
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-release.sh"
TEST_CADIA_ROOT=$(mktemp -d)
TEST_CADIA_ROOT=$(realpath "$TEST_CADIA_ROOT")
trap 'rm -rf "$TEST_CADIA_ROOT"' EXIT
export TEST_CADIA_ROOT TEST_CADIA_CASE TEST_CADIA_LOG
TEST_CADIA_LOG="$TEST_CADIA_ROOT/calls"
mkdir -p "$TEST_CADIA_ROOT/infra/robinhood-mainnet"
cat > "$TEST_CADIA_ROOT/infra/robinhood-mainnet/compose-up.sh" <<'WRAPPER'
#!/usr/bin/env bash
cat >/dev/null
printf 'wrapper\n' >> "$TEST_CADIA_LOG"
WRAPPER
chmod +x "$TEST_CADIA_ROOT/infra/robinhood-mainnet/compose-up.sh"
docker() {
  printf 'docker %s\n' "$*" >> "$TEST_CADIA_LOG"
  case "$1 $2" in
    'ps --filter')
      printf 'aaaaaaaaaaaa\n'
      [[ "$TEST_CADIA_CASE" != duplicate ]] || printf 'bbbbbbbbbbbb\n' ;;
    'inspect --format')
      if [[ "$3" == *working_dir* ]]; then
        printf '%s/infra/robinhood-mainnet\n' "$TEST_CADIA_ROOT"
      elif [[ "$4" == bbbbbbbbbbbb ]]; then
        printf 'running \n'
      elif [[ "$TEST_CADIA_CASE" == unhealthy ]]; then
        printf 'running unhealthy\n'
      else printf 'running healthy\n'; fi ;;
    'info --format') printf '%s\n' "$TEST_CADIA_ROOT" ;;
    'compose version') printf '5.2.0\n' ;;
    'compose ps')
      if [[ "$4" == autopilot ]]; then printf 'bbbbbbbbbbbb\n'; else printf 'aaaaaaaaaaaa\n'; fi ;;
    'ps --format') : ;;
    *) return 99 ;;
  esac
}
git() {
  printf 'git %s\n' "$*" >> "$TEST_CADIA_LOG"
  shift 2
  case "$1" in
    rev-parse)
      if [[ "$2" == --show-toplevel ]]; then printf '%s\n' "$TEST_CADIA_ROOT"; else printf '%040d\n' 1; fi ;;
    diff-index) [[ "$TEST_CADIA_CASE" != dirty ]] ;;
    status) [[ "$TEST_CADIA_CASE" != untracked ]] || printf '?? infra/operator.sh\n' ;;
    fetch) : ;;
    merge-base) [[ "$TEST_CADIA_CASE" != diverged ]] ;;
    merge) : ;;
    *) return 99 ;;
  esac
}
df() {
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n'
  if [[ "$TEST_CADIA_CASE" == disk ]]; then printf 'fixture 40000000 20000000 20000000 50%% /\n'; else printf 'fixture 80000000 10000000 70000000 12%% /\n'; fi
}
sudo() { printf '{"WantRunning":true,"RunSSH":false}\n'; }
curl() {
  if [[ "$*" == *info/contracts* ]]; then printf '{"chainId":4663}\n'
  elif [[ "$TEST_CADIA_CASE" == version ]]; then printf '%040d\n' 2
  else printf '%040d\n' 1; fi
}
sleep() { :; }
export -f docker git df sudo curl sleep

run() {
  TEST_CADIA_CASE=$1
  : > "$TEST_CADIA_LOG"
  bash -s -- "$2" "${3:-0000000000000000000000000000000000000001}" < "$script" > "$TEST_CADIA_ROOT/output" 2>&1
}
run good inspect
if grep -Eq 'git .* (fetch|merge)|wrapper' "$TEST_CADIA_LOG"; then exit 1; fi
run good deploy
grep -q '^wrapper$' "$TEST_CADIA_LOG"
grep -q 'Verified backend revision:' "$TEST_CADIA_ROOT/output"
for scenario in duplicate disk dirty untracked diverged; do
  if run "$scenario" deploy; then echo "Unsafe release accepted: $scenario" >&2; exit 1; fi
  if grep -q '^wrapper$' "$TEST_CADIA_LOG"; then exit 1; fi
done
for scenario in unhealthy version; do
  if run "$scenario" deploy; then echo "Failed verification accepted: $scenario" >&2; exit 1; fi
  grep -q '^wrapper$' "$TEST_CADIA_LOG"
done
if run good deploy 'bad;revision'; then exit 1; fi
test ! -s "$TEST_CADIA_LOG"
if run good 'deploy;bad'; then exit 1; fi
test ! -s "$TEST_CADIA_LOG"
printf 'Cadia release:11 scenarios passed\n'
