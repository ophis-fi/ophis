#!/bin/bash
# The security-key ceremony of the business console (key-custody.md section 4; owner's decision 2026-11-16: ONE
# YubiKey and a paper backup). Run it ONCE, on a laptop (never on the Mac mini: it is the production host), Wi-Fi off.
# It makes the production sealing key: a post-quantum age identity (generation g1) that never touches a disk in clear.
# It exists only inside two files, each enough to open it:
#   seal-identity-g1.age        the YubiKey opens it (its PIN, then a touch)
#   seal-identity-g1.paper.age  a passphrase written on paper opens it: the backup if the YubiKey is lost or broken
# Both go to ~/ophis-seal-g1/ with yk.txt (which YubiKey and slot) and README.txt. Copy that folder to a USB stick,
# keep the paper apart from it (a safe), then delete the folder from the laptop before Wi-Fi goes on. Never into iCloud,
# GitHub or Cloudflare. Next to this script: ophis-recipient-g1.txt, the PUBLIC half, for the console.
# Needs: brew install age age-plugin-yubikey (age 1.3 or later, the plugin 0.5), done before Wi-Fi goes off.
# Tested with a stand-in YubiKey by tests/age.mjs (pnpm test:age); the YubiKey steps themselves are the plugin's own.
set -euo pipefail
umask 077
OUT="$HOME/ophis-seal-g1"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=""

stop() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\nThen press Enter. ' "$1"; read -r _; }
serial() { sed -n 's/^# *Serial: \([0-9][0-9]*\),.*/\1/p' "$1"; }
# What macOS sees plugged in: a YubiKey that can hold the key has CCID (its smart-card part) in its name.
seen() { ioreg -p IOUSB -l -w0 2>/dev/null | sed -n 's/.*"USB Product Name" = "\(.*\)"/\1/p' | grep -i -E 'yubi|security key' | tr '\n' ' ' || true; }
# A run that stops keeps nothing (only what it did on the YubiKey: a slot, its PIN), so it can simply be run again.
trap 'if [[ -n "$WORK" ]]; then rm -rf "$WORK"; fi' EXIT
trap 'printf "\nSTOPPED: the step above failed. Nothing was kept: run this again.\n" >&2' ERR

[[ "$(age --version 2>/dev/null)" =~ ^v1\.([3-9]|[1-9][0-9])\. ]] || stop "age 1.3 or later is needed: Wi-Fi on, brew install age age-plugin-yubikey, then run this again."
[[ "$(age-plugin-yubikey --version 2>/dev/null)" =~ ^age-plugin-yubikey\ 0\.5\. ]] || stop "age-plugin-yubikey 0.5 is needed: Wi-Fi on, brew install age-plugin-yubikey, then run this again."
# Online = a default route, IPv4 or IPv6. macOS route exits 0 even with none ("not in table"): read its answer, not its status.
online() { route -n get "$@" default 2>/dev/null | grep -q 'interface:'; }
if online || online -inet6; then stop "This laptop is online. Turn Wi-Fi off (and unplug any network cable), then run this again."; fi
[[ ! -e "$OUT" ]] || stop "$OUT exists already: a key was made. Keep it if the console seals to it; otherwise move it away and run this again."
# The key folder leaves the laptop after a run; the public half stays here: a second key is never made by mistake.
[[ ! -e "$HERE/ophis-recipient-g1.txt" ]] || stop "A key was made before: its public half, ophis-recipient-g1.txt, is next to this script, and the console may seal to it. To make another key on purpose, move that file away first."
WORK=$(mktemp -d "$HOME/.ophis-seal-work.XXXXXX")
cd "$WORK"

step "Plug in your YubiKey. When asked, choose its PIN (6 to 8 characters, letters allowed; three wrong tries lock it for good), and touch it when it blinks."
if ! age-plugin-yubikey --generate --name ophis-seal-g1 --pin-policy once --touch-policy always > yk.txt; then
  s=$(seen)
  stop "The YubiKey was not set up (the lines above say why). macOS sees: ${s:-no YubiKey}. A YubiKey 5 is needed: its name has CCID."
fi
r=$(sed -n 's/^# *Recipient: //p' yk.txt)
[[ "$r" =~ ^age1yubikey1[02-9ac-hj-np-z]+$ ]] || stop "The YubiKey gave no hardware recipient. Run this again."
s=$(serial yk.txt)
[[ -n "$s" ]] || stop "The YubiKey gave no serial number. Run this again."
printf 'YubiKey serial %s is set up.\n' "$s"

# The secret half: in this shell's memory only, never on a disk in clear; sealed twice, to the YubiKey and to a passphrase.
id=$(age-keygen -pq 2> keygen.txt)
recipient=$(sed -n 's/^Public key: //p' keygen.txt)
rm keygen.txt
# The form the Worker takes (age1pq1, then 1,500 to 2,500 characters). The length apart: macOS bash 3.2 counts to 255 in a regex.
if ! [[ "$recipient" =~ ^age1pq1[a-z0-9]+$ ]] || (( ${#recipient} < 1507 || ${#recipient} > 2507 )); then
  stop "age-keygen gave no post-quantum recipient. Run this again."
fi
printf '%s\n' "$recipient" > ophis-recipient-g1.txt
printf '%s\n' "$id" | age -r "$r" -o seal-identity-g1.age
step "Now the paper backup. age will ask for a passphrase: press Enter, and it makes a strong one. Write it on paper EXACTLY as printed (every word and dash). The paper goes to a safe, apart from the USB stick."
printf '%s\n' "$id" | age -p -o seal-identity-g1.paper.age
id=""
step "When the passphrase is on paper, the screen will be cleared."
printf '\033[2J\033[3J\033[H'

# Each must open the key and give back that same recipient, before anything depends on it.
printf '\nCheck 1 of 2, the YubiKey: enter its PIN, then touch it when it blinks.\n'
age -d -i yk.txt seal-identity-g1.age | age-keygen -y | cmp -s - ophis-recipient-g1.txt \
  || stop "The YubiKey did not open the key. Nothing was kept: run this again."
echo "The YubiKey opens the key."
printf '\nCheck 2 of 2, the paper: type the passphrase from your paper.\n'
age -d seal-identity-g1.paper.age | age-keygen -y | cmp -s - ophis-recipient-g1.txt \
  || stop "That passphrase did not open the paper copy. Nothing was kept: run this again, with a new paper."
echo "The paper opens the key."

fingerprint=$(printf '%s' "$recipient" | shasum -a 256 | cut -d ' ' -f 1)
# The commands below are each on a line of their own, with no comment after them: macOS's Terminal runs zsh, which
# does not take "#" as a comment when typed (tests/age.mjs runs these lines in zsh -f -i).
{ printf 'Ophis business console, sealing key g1. Fingerprint (SHA-256 of ophis-recipient-g1.txt without its line end):\n%s\n' "$fingerprint"
cat <<'EOF'

Keep: seal-identity-g1.age (the YubiKey opens it), seal-identity-g1.paper.age (the passphrase on paper opens it),
yk.txt (which YubiKey and slot). On a USB stick; the paper in a safe, apart from the stick. Whoever holds both the
paper and this folder can open every sealed file. Never on a computer that goes online, never in iCloud, GitHub or
Cloudflare.

Open a sealed item. Wi-Fi off, in this folder, item.age next to it. This must print the SHA-256 "operator get" printed:
  shasum -a 256 item.age
Then make the RAM disk (/Volumes/OphisRAM, 100 MB, in memory; a name only this uses):
  diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://204800)
Then, with the YubiKey plugged in (its PIN, a touch):
  age -d -i yk.txt seal-identity-g1.age | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age
Or, without the YubiKey, with the passphrase from the paper:
  age -d seal-identity-g1.paper.age | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age
Treat /Volumes/OphisRAM/item.pdf as a file from a stranger. After use:
  diskutil eject OphisRAM

The YubiKey lost or broken: lock the key to a new YubiKey, with the paper. Nothing changes in the console. Wi-Fi off,
in this folder, the new YubiKey plugged in:
  age-plugin-yubikey --generate --name ophis-seal-g1 --pin-policy once --touch-policy always > yk-new.txt
This must print "go on". If it prints "STOP", go no further:
  grep -q '^# *Recipient: age1yubikey1' yk-new.txt && echo "go on" || echo "STOP"
Then, with the passphrase from the paper:
  age -d seal-identity-g1.paper.age | age -r "$(sed -n 's/^# *Recipient: //p' yk-new.txt)" -o seal-identity-g1.new.age
This must print "the new YubiKey opens it" (its PIN, a touch):
  age -d -i yk-new.txt seal-identity-g1.new.age | age-keygen -y | cmp - ophis-recipient-g1.txt && echo "the new YubiKey opens it"
Then: seal-identity-g1.new.age becomes seal-identity-g1.age, yk-new.txt becomes yk.txt, and the folder goes on the
USB stick again.
EOF
} > README.txt
cd "$HOME"
mv "$WORK" "$OUT"
WORK=""
cp "$OUT/ophis-recipient-g1.txt" "$HERE/ophis-recipient-g1.txt"
printf '\nDone. Fingerprint of the sealing key:\n%s\n\n' "$fingerprint"
printf 'Next, still offline: copy %s to a USB stick and check the copy is there,\n' "$OUT"
printf 'then delete it from this laptop (rm -rf %q) BEFORE Wi-Fi goes back on. Then send the fingerprint above.\n' "$OUT"
printf 'The public half is in %s/ophis-recipient-g1.txt.\n' "$HERE"
