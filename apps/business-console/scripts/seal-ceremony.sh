#!/bin/bash
# The security-key ceremony of the business console (key-custody.md section 4, ARCHITECTURE.md "Sealing"). Run it ONCE,
# on a laptop (never on the Mac mini: it is the production host), Wi-Fi off, with the two YubiKey 5 kept for sealing only.
# It makes the production sealing key: a post-quantum age identity (generation g1) that never touches a disk in clear.
# It exists only inside seal-identity-g1.age, a file that either YubiKey opens (PIN, then a touch).
#   ~/ophis-seal-g1/        the key file, the two YubiKey stubs, README.txt. Copy this folder to two USB sticks, one
#                           kept with each YubiKey, then delete it from the laptop before Wi-Fi goes on. Never into
#                           iCloud, GitHub or Cloudflare: its outer lock is classic P-256, so a copy there would undo
#                           the post-quantum protection of every sealed file.
#   next to this script     ophis-recipient-g1.txt, the PUBLIC half, for the console (pro.ophis.fi seals to it).
# Needs: brew install age age-plugin-yubikey (age 1.3 or later, the plugin 0.5), done before Wi-Fi goes off.
# Tested with stand-in keys by tests/age.mjs (pnpm test:age); the YubiKey steps themselves are the plugin's own.
set -euo pipefail
umask 077
OUT="$HOME/ophis-seal-g1"
HERE="$(cd "$(dirname "$0")" && pwd)"

stop() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\nThen press Enter. ' "$1"; read -r _; }
serial() { sed -n 's/^# *Serial: \([0-9][0-9]*\),.*/\1/p' "$1"; }
trap 'printf "\nSTOPPED: the step above failed. Nothing uses %s yet: move it away and run this again.\n" "$OUT" >&2' ERR

[[ "$(age --version 2>/dev/null)" =~ ^v1\.([3-9]|[1-9][0-9])\. ]] || stop "age 1.3 or later is needed: Wi-Fi on, brew install age age-plugin-yubikey, then run this again."
[[ "$(age-plugin-yubikey --version 2>/dev/null)" =~ ^age-plugin-yubikey\ 0\.5\. ]] || stop "age-plugin-yubikey 0.5 is needed: Wi-Fi on, brew install age-plugin-yubikey, then run this again."
# Online = a default route, IPv4 or IPv6. macOS route exits 0 even with none ("not in table"): read its answer, not its status.
online() { route -n get "$@" default 2>/dev/null | grep -q 'interface:'; }
if online || online -inet6; then stop "This laptop is online. Turn Wi-Fi off (and unplug any network cable), then run this again."; fi
[[ ! -e "$OUT" ]] || stop "$OUT exists already: a key was made, or a run stopped half way. Keep it if the console seals to it; otherwise move it away and run this again."
# The key folder leaves the laptop after a run; the public half stays here: a second key is never made by mistake.
[[ ! -e "$HERE/ophis-recipient-g1.txt" ]] || stop "A key was made before: its public half, ophis-recipient-g1.txt, is next to this script, and the console may seal to it. To make another key on purpose, move that file away first."
mkdir "$OUT"
cd "$OUT"

# One YubiKey at a time: each gets its own PIN (the plugin makes you change the default one) and a key in a free slot.
for k in A B; do
  step "Plug in YubiKey $k ONLY (the other one out). Choose its PIN when asked: 6 to 8 characters, letters allowed. Three wrong tries lock it for good. Touch it when it blinks."
  age-plugin-yubikey --generate --name "ophis-seal-$k" --pin-policy once --touch-policy always > "yk-$k.txt"
  r=$(sed -n 's/^# *Recipient: //p' "yk-$k.txt")
  [[ "$r" =~ ^age1yubikey1[02-9ac-hj-np-z]+$ ]] || stop "YubiKey $k gave no hardware recipient. Move $OUT away and run this again."
  s=$(serial "yk-$k.txt")
  [[ -n "$s" ]] || stop "YubiKey $k gave no serial number. Move $OUT away and run this again."
  # Two different YubiKeys, or losing one would lose the key: A left in at step B would get a second slot, and B nothing.
  if [[ $k == B && "$s" == "$(serial yk-A.txt)" ]]; then stop "That was YubiKey A again (serial $s). Move $OUT away and run this again, with the other key in at step B."; fi
  printf '%s\n' "$r" >> yk-recipients.txt
  printf 'YubiKey %s is serial %s. Mark it "ophis-seal-%s".\n' "$k" "$s" "$k"
done

# The secret half goes through a pipe only: from age-keygen straight into a file that only the two YubiKeys open.
age-keygen -pq 2> keygen.txt | age -R yk-recipients.txt -o seal-identity-g1.age
recipient=$(sed -n 's/^Public key: //p' keygen.txt)
rm keygen.txt
# The form the Worker takes (age1pq1, then 1,500 to 2,500 characters). The length apart: macOS bash 3.2 counts to 255 in a regex.
if ! [[ "$recipient" =~ ^age1pq1[a-z0-9]+$ ]] || (( ${#recipient} < 1507 || ${#recipient} > 2507 )); then
  stop "age-keygen gave no post-quantum recipient. Move $OUT away and run this again."
fi
printf '%s\n' "$recipient" > ophis-recipient-g1.txt

# Each YubiKey must open the key file and give back that same recipient, before anything depends on it.
for k in B A; do
  if [[ $k == A ]]; then step "Unplug YubiKey B. Plug in YubiKey A."; fi
  printf '\nYubiKey %s: enter its PIN, then touch it when it blinks.\n' "$k"
  age -d -i "yk-$k.txt" seal-identity-g1.age | age-keygen -y | cmp -s - ophis-recipient-g1.txt \
    || stop "YubiKey $k did not open the key file to that recipient. Nothing uses it yet: move $OUT away and run this again."
  echo "YubiKey $k opens the key file."
done

fingerprint=$(printf '%s' "$recipient" | shasum -a 256 | cut -d ' ' -f 1)
# The commands below are each on a line of their own, with no comment after them: macOS's Terminal runs zsh, which
# does not take "#" as a comment when typed (tests/age.mjs runs these lines in zsh -f -i).
{ printf 'Ophis business console, sealing key g1. Fingerprint (SHA-256 of ophis-recipient-g1.txt without its line end):\n%s\n' "$fingerprint"
cat <<'EOF'

Keep: seal-identity-g1.age (the key, locked to the two YubiKeys), yk-A.txt and yk-B.txt (which YubiKey and slot),
yk-recipients.txt. Two USB sticks, one with each YubiKey, in two places. Never on a computer that goes online, and
never in iCloud, GitHub or Cloudflare.

Open a sealed item. Wi-Fi off, in this folder, item.age next to it, YubiKey A plugged in (with B: yk-B.txt); PIN once,
a touch. The clear file goes to a RAM disk only, never to this stick. This must print the SHA-256 "operator get" printed:
  shasum -a 256 item.age
Then make the RAM disk (/Volumes/OphisRAM, 100 MB, in memory; a name only this uses) and open the item onto it:
  diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://204800)
  age -d -i yk-A.txt seal-identity-g1.age | age -d -i - -o /Volumes/OphisRAM/item.pdf item.age
Treat /Volumes/OphisRAM/item.pdf as a file from a stranger. After use:
  diskutil eject OphisRAM

A YubiKey lost or broken (here B): lock the key to the one left (A) and a new YubiKey (C). Nothing changes in the
console. Wi-Fi off, in this folder, one line at a time. First the new key, C, plugged in ALONE:
  age-plugin-yubikey --generate --name ophis-seal-C --pin-policy once --touch-policy always > yk-C.txt
This must print "two keys: go on". If it prints "STOP", go no further: C was not made, or it was A again.
  [ "$(sed -n 's/^# *Recipient: //p' yk-A.txt yk-C.txt | grep -c '^age1yubikey1')" = 2 ] && [ "$(sed -n 's/^# *Serial: \([0-9]*\),.*/\1/p' yk-A.txt yk-C.txt | sort -u | grep -c .)" = 2 ] && echo "two keys: go on" || echo "STOP"
Then the new lock, with A plugged in, and its check:
  sed -n 's/^# *Recipient: //p' yk-A.txt yk-C.txt > yk-recipients-new.txt
  age -d -i yk-A.txt seal-identity-g1.age | age -R yk-recipients-new.txt -o seal-identity-g1.new.age
  age -d -i yk-A.txt seal-identity-g1.new.age | age-keygen -y | cmp - ophis-recipient-g1.txt && echo "A opens it"
Then with C plugged in instead:
  age -d -i yk-C.txt seal-identity-g1.new.age | age-keygen -y | cmp - ophis-recipient-g1.txt && echo "C opens it"
Both must say so. Then: seal-identity-g1.new.age becomes seal-identity-g1.age, yk-recipients-new.txt becomes
yk-recipients.txt, keep yk-C.txt, and put the folder on both sticks again.
EOF
} > README.txt
cp ophis-recipient-g1.txt "$HERE/ophis-recipient-g1.txt"
printf '\nDone. Fingerprint of the sealing key:\n%s\n\n' "$fingerprint"
printf 'Next, still offline: copy %s to two USB sticks (one with each YubiKey), check both copies are there,\n' "$OUT"
printf 'then delete it from this laptop (rm -rf %q) BEFORE Wi-Fi goes back on. Then send the fingerprint above.\n' "$OUT"
printf 'The public half is in %s/ophis-recipient-g1.txt.\n' "$HERE"
