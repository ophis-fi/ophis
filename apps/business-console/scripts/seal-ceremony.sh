#!/bin/bash
# The key ceremony of the business console (key-custody.md section 4; owner's decisions 2026-11-16: no YubiKey for
# now, the key on paper). Run it ONCE, on a laptop (never on the Mac mini: it is the production host), Wi-Fi off.
# It makes the production sealing key: a post-quantum age identity (generation g1), 77 characters. The key is shown
# once and written by hand on TWO papers, kept in two places (like a wallet's seed phrase): each opens every sealed
# file. It is never on a disk in clear, and nothing secret is left on the laptop.
# Next to this script (the iCloud folder): ophis-recipient-g1.txt, the PUBLIC half, for the console, and
# ophis-seal-g1-README.txt (how to open a sealed item, and how to add a YubiKey 5 later).
# Needs: brew install age (1.3 or later), done before Wi-Fi goes off.
# Tested by tests/age.mjs (pnpm test:age), in a pseudo-terminal that answers as the key holder does.
set +x # never trace: the key passes through variables of this shell
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HOME/.ophis-seal-g1.run"
CLAIMED=0
DONE=0
WROTE=()

stop() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\nThen press Enter. ' "$1"; read -r _; }
# The run works in a folder of its own (claimed at once: a second run going on stops). It holds only public things,
# and goes at the end whatever happens; until the very end, a run that stops also takes back what it wrote next to
# this script (and nothing else there), so it keeps nothing and can simply be run again.
finish() {
  if [[ $CLAIMED == 1 ]]; then
    if [[ $DONE == 0 ]] && (( ${#WROTE[@]} )); then rm -f "${WROTE[@]}"; fi
    rm -rf "$WORK"
  fi
}
trap finish EXIT
trap 'printf "\nSTOPPED: the step above failed. Nothing was kept: run this again.\n" >&2' ERR

[[ "$(age --version 2>/dev/null)" =~ ^v1\.([3-9]|[1-9][0-9])\. ]] || stop "age 1.3 or later is needed: Wi-Fi on, brew install age, then run this again."
# The key is shown once for the papers: on a terminal only, never into a pipe or a log (Codex: "| tee log" kept it whole).
[[ -t 0 && -t 1 ]] || stop "Run it in Terminal as it is, not piped or logged: it shows the key once, on the screen only."
# Online = a default route, IPv4 or IPv6. macOS route exits 0 even with none ("not in table"): read its answer, not its status.
online() { route -n get "$@" default 2>/dev/null | grep -q 'interface:'; }
if online || online -inet6; then stop "This laptop is online. Turn Wi-Fi off (and unplug any network cable), then run this again."; fi
# A key made before: its public half stays here, and the console may seal to it. A second key is never made by mistake.
[[ ! -e "$HERE/ophis-recipient-g1.txt" ]] || stop "A key was made before: its public half, ophis-recipient-g1.txt, is next to this script, and the console may seal to it. To make another key on purpose, move that file away first."
mkdir "$WORK" 2>/dev/null || stop "Another run is going on (or one was killed: then delete the folder $WORK and run this again)."
CLAIMED=1
cd "$WORK"

# The key: in this shell's memory only, never on a disk in clear; shown once for the papers.
id=$(age-keygen -pq 2> keygen.txt)
recipient=$(sed -n 's/^Public key: //p' keygen.txt)
# The form the Worker takes (age1pq1, then 1,500 to 2,500 characters). The length apart: macOS bash 3.2 counts to 255 in a regex.
if ! [[ "$recipient" =~ ^age1pq1[a-z0-9]+$ ]] || (( ${#recipient} < 1507 || ${#recipient} > 2507 )); then
  stop "age-keygen gave no post-quantum recipient. Run this again."
fi
printf '%s\n' "$recipient" > ophis-recipient-g1.txt
key=$(printf '%s\n' "$id" | sed -n 's/^AGE-SECRET-KEY-PQ-1\([0-9A-Z]*\)$/\1/p')
id=""
[[ ${#key} -ge 40 ]] || stop "age-keygen gave no key of the expected form. Run this again."
step "Now the key, to write by hand on TWO papers, kept in two different places (a safe, and somewhere else). Each paper opens every sealed file: keep them like a wallet's seed phrase."
printf '\nWrite this on both papers exactly (capital letters and digits; the spaces only help you copy it):\n\n   AGE-SECRET-KEY-PQ-1 %s\n' "$(printf '%s' "$key" | sed 's/.\{4\}/& /g')"
step "When it is on BOTH papers, the screen will be cleared."
printf '\033[2J\033[3J\033[H'
pbcopy < /dev/null 2>/dev/null || true # in case the key was copied from the screen: the clipboard is emptied

# Each paper must give back the key: typed from it by hand, unseen, then checked against the public half. Three tries each.
for paper in 1 2; do
  for try in 1 2 3; do
    printf '\nCheck %s of 2: type the key from paper %s, by hand (it is not shown; spaces do not matter), then Enter.\n' "$paper" "$paper"
    read -rs typed
    typed=$(printf '%s' "$typed" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
    if printf '%s\n' "$typed" | age-keygen -y 2>/dev/null | cmp -s - ophis-recipient-g1.txt; then break; fi
    typed=""
    if [[ $try == 3 ]]; then stop "Three tries, and paper $paper does not give the key. Nothing was kept: run this again, with new papers."; fi
    printf '\nThat is not the key: compare paper %s with what you typed, and type it again.\n' "$paper"
  done
  typed=""
  echo "Paper $paper gives the key."
done
key=""

fingerprint=$(printf '%s' "$recipient" | shasum -a 256 | cut -d ' ' -f 1)
# The commands below are each on a line of their own, with no comment after them: macOS's Terminal runs zsh, which
# does not take "#" as a comment when typed (tests/age.mjs runs these lines in zsh -f -i).
{ printf 'Ophis business console, sealing key g1. Fingerprint (SHA-256 of ophis-recipient-g1.txt without its line end):\n%s\n' "$fingerprint"
cat <<'EOF'

The key exists only on two papers, in two places; each opens every sealed file. Never type it on a computer that is
online, and never put it in iCloud, GitHub or Cloudflare. ophis-recipient-g1.txt (the public half) and this file are
in the iCloud folder "Ophis seal ceremony". Typed keys below: spaces and small letters are fine; Enter, then Control-D.

Open a sealed item. Wi-Fi off, in a folder with item.age (not the iCloud folder). This must print the SHA-256
"operator get" printed:
  shasum -a 256 item.age
Then make the RAM disk (/Volumes/OphisRAM, 100 MB, in memory; a name only this uses):
  diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://204800)
Then type the key from a paper (not shown), Enter, then Control-D:
  stty -echo; tr -d ' ' | tr '[:lower:]' '[:upper:]' | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age; stty echo
Treat /Volumes/OphisRAM/item.pdf as a file from a stranger. After use:
  diskutil eject OphisRAM

A paper lost or damaged: copy the other one onto a new paper, by hand. If the lost paper may be in someone's hands,
everything sealed to this key is open to them: make a new key (g2).

Later, a YubiKey 5 (with PIV; not the Bio or Security Key series), so that daily opening needs no paper: lock the
key to it from a paper. Nothing changes in the console. Wi-Fi off, in a new folder on the laptop (NEVER the iCloud
folder: the copy must not reach iCloud) with ophis-recipient-g1.txt copied into it, the YubiKey plugged in, after
brew install age-plugin-yubikey:
  age-plugin-yubikey --generate --name ophis-seal-g1 --pin-policy once --touch-policy always > yk.txt
This must print "go on". If it prints "STOP", go no further:
  grep -q '^# *Recipient: age1yubikey1' yk.txt && echo "go on" || echo "STOP"
Then type the key from a paper (not shown), Enter, then Control-D:
  stty -echo; tr -d ' ' | tr '[:lower:]' '[:upper:]' | age -r "$(sed -n 's/^# *Recipient: //p' yk.txt)" -o seal-identity-g1.age; stty echo
This must print "the YubiKey opens it" (its PIN, a touch):
  age -d -i yk.txt seal-identity-g1.age | age-keygen -y | cmp - ophis-recipient-g1.txt && echo "the YubiKey opens it"
Then keep that folder on a USB stick, delete it from the laptop, and open items with:
  age -d -i yk.txt seal-identity-g1.age | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age
EOF
} > README.txt
WROTE+=("$HERE/ophis-seal-g1-README.txt")
cp README.txt "$HERE/ophis-seal-g1-README.txt"
WROTE+=("$HERE/ophis-recipient-g1.txt")
cp ophis-recipient-g1.txt "$HERE/ophis-recipient-g1.txt"
DONE=1
printf '\nDone. Fingerprint of the sealing key:\n%s\n\n' "$fingerprint"
printf 'Put the two papers in two different places. Nothing secret is left on this laptop.\n'
printf 'Turn Wi-Fi back on and send the fingerprint above.\n'
