#!/bin/bash
# The security-key ceremony of the business console (key-custody.md section 4; owner's decision 2026-11-16: ONE
# YubiKey and a paper backup). Run it ONCE, on a laptop (never on the Mac mini: it is the production host), Wi-Fi off.
# It makes the production sealing key: a post-quantum age identity (generation g1), 77 characters, never on a disk in
# clear. It exists in two places, each enough to open every sealed file:
#   ~/ophis-seal-g1/seal-identity-g1.age   locked to the YubiKey (its PIN, then a touch); with yk.txt (which YubiKey
#                                          and slot) and README.txt. Copy the folder to a USB stick, then delete it from
#                                          the laptop before Wi-Fi goes on. Never into iCloud, GitHub or Cloudflare.
#   the paper                              the key itself, written by hand like a wallet's seed phrase, kept in a safe.
# Next to this script (the iCloud folder): ophis-recipient-g1.txt, the PUBLIC half, for the console, and README.txt.
# Needs: brew install age age-plugin-yubikey (age 1.3 or later, the plugin 0.5), done before Wi-Fi goes off.
# Tested with a stand-in YubiKey by tests/age.mjs (pnpm test:age); the YubiKey steps themselves are the plugin's own.
set +x # never trace: the key passes through variables of this shell
set -euo pipefail
umask 077
OUT="$HOME/ophis-seal-g1"
HERE="$(cd "$(dirname "$0")" && pwd)"
CLAIMED=0
DONE=0

stop() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\nThen press Enter. ' "$1"; read -r _; }
serial() { sed -n 's/^# *Serial: \([0-9][0-9]*\),.*/\1/p' "$1"; }
# What macOS sees plugged in: a YubiKey that can hold the key has CCID (its smart-card part) in its name.
seen() { ioreg -p IOUSB -l -w0 2>/dev/null | sed -n 's/.*"USB Product Name" = "\(.*\)"/\1/p' | grep -i -E 'yubi|security key' | tr '\n' ' ' || true; }
# Until the very end, a run that stops takes back what it made (the key folder it claimed, the public half), so it keeps
# nothing but what it did on the YubiKey (a slot, its PIN) and can simply be run again.
undo() { if [[ $DONE == 0 && $CLAIMED == 1 ]]; then rm -rf "$OUT"; rm -f "$HERE/ophis-recipient-g1.txt" "$HERE/README.txt"; fi; }
trap undo EXIT
trap 'printf "\nSTOPPED: the step above failed. Nothing was kept: run this again.\n" >&2' ERR

[[ "$(age --version 2>/dev/null)" =~ ^v1\.([3-9]|[1-9][0-9])\. ]] || stop "age 1.3 or later is needed: Wi-Fi on, brew install age age-plugin-yubikey, then run this again."
[[ "$(age-plugin-yubikey --version 2>/dev/null)" =~ ^age-plugin-yubikey\ 0\.5\. ]] || stop "age-plugin-yubikey 0.5 is needed: Wi-Fi on, brew install age-plugin-yubikey, then run this again."
# Online = a default route, IPv4 or IPv6. macOS route exits 0 even with none ("not in table"): read its answer, not its status.
online() { route -n get "$@" default 2>/dev/null | grep -q 'interface:'; }
if online || online -inet6; then stop "This laptop is online. Turn Wi-Fi off (and unplug any network cable), then run this again."; fi
# The key folder leaves the laptop after a run; the public half stays here: a second key is never made by mistake.
[[ ! -e "$HERE/ophis-recipient-g1.txt" ]] || stop "A key was made before: its public half, ophis-recipient-g1.txt, is next to this script, and the console may seal to it. To make another key on purpose, move that file away first."
# The folder is claimed at once (mkdir fails if it exists): a run already going on, or a key made before, stops this one.
mkdir "$OUT" 2>/dev/null || stop "$OUT exists already: a key was made, or another run is going on. Keep it if the console seals to it; otherwise move it away and run this again."
CLAIMED=1
cd "$OUT"

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

# The key: in this shell's memory only, never on a disk in clear; locked to the YubiKey, and shown once for the paper.
id=$(age-keygen -pq 2> keygen.txt)
recipient=$(sed -n 's/^Public key: //p' keygen.txt)
rm keygen.txt
# The form the Worker takes (age1pq1, then 1,500 to 2,500 characters). The length apart: macOS bash 3.2 counts to 255 in a regex.
if ! [[ "$recipient" =~ ^age1pq1[a-z0-9]+$ ]] || (( ${#recipient} < 1507 || ${#recipient} > 2507 )); then
  stop "age-keygen gave no post-quantum recipient. Run this again."
fi
printf '%s\n' "$recipient" > ophis-recipient-g1.txt
printf '%s\n' "$id" | age -r "$r" -o seal-identity-g1.age
key=$(printf '%s\n' "$id" | sed -n 's/^AGE-SECRET-KEY-PQ-1\([0-9A-Z]*\)$/\1/p')
id=""
[[ ${#key} -ge 40 ]] || stop "age-keygen gave no key of the expected form. Run this again."
step "Now the paper: the key itself, like a wallet's seed phrase. Whoever holds the paper can open every sealed file: it goes to a safe."
printf '\nWrite this on paper exactly (capital letters and digits; the spaces only help you copy it):\n\n   AGE-SECRET-KEY-PQ-1 %s\n' "$(printf '%s' "$key" | sed 's/.\{4\}/& /g')"
step "When it is on paper, the screen will be cleared."
printf '\033[2J\033[3J\033[H'

# The paper must give back the key: typed from it, unseen, then checked against the public half. Three tries.
for try in 1 2 3; do
  printf '\nCheck 1 of 2, the paper: type the key from your paper (it is not shown; spaces do not matter), then Enter.\n'
  read -rs typed
  typed=$(printf '%s' "$typed" | tr -d ' ' | tr '[:lower:]' '[:upper:]')
  if printf '%s\n' "$typed" | age-keygen -y 2>/dev/null | cmp -s - ophis-recipient-g1.txt; then break; fi
  typed=""
  if [[ $try == 3 ]]; then stop "Three tries, and the paper does not give the key. Nothing was kept: run this again, with a new paper."; fi
  printf '\nThat is not the key: compare your paper with what you typed, and type it again.\n'
done
typed=""
key=""
echo "The paper gives the key."
printf '\nCheck 2 of 2, the YubiKey: enter its PIN, then touch it when it blinks.\n'
age -d -i yk.txt seal-identity-g1.age | age-keygen -y | cmp -s - ophis-recipient-g1.txt \
  || stop "The YubiKey did not open the key. Nothing was kept: run this again."
echo "The YubiKey opens the key."

fingerprint=$(printf '%s' "$recipient" | shasum -a 256 | cut -d ' ' -f 1)
# The commands below are each on a line of their own, with no comment after them: macOS's Terminal runs zsh, which
# does not take "#" as a comment when typed (tests/age.mjs runs these lines in zsh -f -i).
{ printf 'Ophis business console, sealing key g1. Fingerprint (SHA-256 of ophis-recipient-g1.txt without its line end):\n%s\n' "$fingerprint"
cat <<'EOF'

Keep: seal-identity-g1.age (the YubiKey opens it) and yk.txt (which YubiKey and slot) on a USB stick; the paper, the
key itself, in a safe: whoever holds it can open every sealed file. README.txt and ophis-recipient-g1.txt (the public
half) are also in the iCloud folder "Ophis seal ceremony". Never type the key on a computer that is online, and never
put it in iCloud, GitHub or Cloudflare. Typed keys below: capital letters, spaces ignored; Enter, then Control-D.

Open a sealed item. Wi-Fi off, in a folder with item.age. This must print the SHA-256 "operator get" printed:
  shasum -a 256 item.age
Then make the RAM disk (/Volumes/OphisRAM, 100 MB, in memory; a name only this uses):
  diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://204800)
Then, in this folder with the YubiKey plugged in (its PIN, a touch):
  age -d -i yk.txt seal-identity-g1.age | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age
Or, without the YubiKey: type the key from the paper (not shown), Enter, then Control-D:
  stty -echo; tr -d ' ' | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age; stty echo
Treat /Volumes/OphisRAM/item.pdf as a file from a stranger. After use:
  diskutil eject OphisRAM

The YubiKey or the USB stick lost or broken: make a new YubiKey copy from the paper. Nothing changes in the console.
Wi-Fi off, in a folder with ophis-recipient-g1.txt (the iCloud folder has it), the YubiKey plugged in:
  age-plugin-yubikey --generate --name ophis-seal-g1 --pin-policy once --touch-policy always > yk-new.txt
This must print "go on". If it prints "STOP", go no further:
  grep -q '^# *Recipient: age1yubikey1' yk-new.txt && echo "go on" || echo "STOP"
Then type the key from the paper (not shown), Enter, then Control-D:
  stty -echo; tr -d ' ' | age -r "$(sed -n 's/^# *Recipient: //p' yk-new.txt)" -o seal-identity-g1.new.age; stty echo
This must print "the new YubiKey opens it" (its PIN, a touch):
  age -d -i yk-new.txt seal-identity-g1.new.age | age-keygen -y | cmp - ophis-recipient-g1.txt && echo "the new YubiKey opens it"
Then: seal-identity-g1.new.age becomes seal-identity-g1.age, yk-new.txt becomes yk.txt, on a USB stick again.

The paper lost: write a new one from the YubiKey copy. Wi-Fi off, in this folder, the YubiKey plugged in (its PIN, a touch):
  age -d -i yk.txt seal-identity-g1.age | grep '^AGE-SECRET-KEY-PQ-1'
Write it on paper, then clear the screen:
  printf '\033[2J\033[3J\033[H'
If the lost paper may be in someone's hands, everything sealed to this key is open to them: make a new key (g2).
EOF
} > README.txt
cp README.txt "$HERE/README.txt"
cp ophis-recipient-g1.txt "$HERE/ophis-recipient-g1.txt"
DONE=1
printf '\nDone. Fingerprint of the sealing key:\n%s\n\n' "$fingerprint"
printf 'Next, still offline: copy %s to a USB stick and check the copy is there,\n' "$OUT"
printf 'then delete it from this laptop (rm -rf %q) BEFORE Wi-Fi goes back on.\n' "$OUT"
printf 'Put the paper in a safe. Then send the fingerprint above.\n'
