#!/bin/bash
# The security-key ceremony of the business console (key-custody.md section 4, ARCHITECTURE.md "Sealing"). Run it ONCE,
# on a laptop (never on the Mac mini: it is the production host), Wi-Fi off, with the two YubiKey 5 kept for sealing only.
# It makes the production sealing key: a post-quantum age identity (generation g1) that never touches a disk in clear.
# It exists only inside seal-identity-g1.age, a file that either YubiKey opens (PIN, then a touch).
#   ~/ophis-seal-g1/        the key file, the two YubiKey stubs, README.txt. Copy this folder to two USB sticks, one
#                           kept with each YubiKey. Never into iCloud, GitHub or Cloudflare: its outer lock is classic
#                           P-256, so a copy there would undo the post-quantum protection of every sealed file.
#   next to this script     ophis-recipient-g1.txt, the PUBLIC half, for the console (pro.ophis.fi seals to it).
# Needs: brew install age age-plugin-yubikey (age 1.3 or later, the plugin 0.5), done before Wi-Fi goes off.
# Tested with stand-in keys by tests/age.mjs (pnpm test:age); the YubiKey steps themselves are the plugin's own.
set -euo pipefail
umask 077
OUT="$HOME/ophis-seal-g1"
HERE="$(cd "$(dirname "$0")" && pwd)"

stop() { printf '\nSTOPPED: %s\n' "$1" >&2; exit 1; }
step() { printf '\n%s\nThen press Enter. ' "$1"; read -r _; }

[[ "$(age --version 2>/dev/null)" =~ ^v1\.([3-9]|[1-9][0-9])\. ]] || stop "age 1.3 or later is needed: Wi-Fi on, brew install age age-plugin-yubikey, then run this again."
[[ "$(age-plugin-yubikey --version 2>/dev/null)" =~ ^age-plugin-yubikey\ 0\.5\. ]] || stop "age-plugin-yubikey 0.5 is needed: Wi-Fi on, brew install age-plugin-yubikey, then run this again."
if route -n get default >/dev/null 2>&1; then stop "This laptop is online. Turn Wi-Fi off (and unplug any network cable), then run this again."; fi
[[ ! -e "$OUT" ]] || stop "$OUT exists already: a key was made before. Keep it. Move that folder away only if you are sure no file was sealed to it."
mkdir "$OUT"
cd "$OUT"

# One YubiKey at a time: each gets its own PIN (the plugin makes you change the default one) and a key in a free slot.
for k in A B; do
  step "Plug in YubiKey $k ONLY (the other one out). Choose its PIN when asked: 6 to 8 characters, letters allowed. Three wrong tries lock it for good. Touch it when it blinks."
  age-plugin-yubikey --generate --name "ophis-seal-$k" --pin-policy once --touch-policy always > "yk-$k.txt"
  r=$(sed -n 's/^# *Recipient: //p' "yk-$k.txt")
  [[ "$r" =~ ^age1yubikey1[02-9ac-hj-np-z]+$ ]] || stop "YubiKey $k gave no hardware recipient. Move $OUT away and run this again."
  printf '%s\n' "$r" >> yk-recipients.txt
  printf 'YubiKey %s is %s. Mark it "ophis-seal-%s".\n' "$k" "$(sed -n 's/^# *Serial: \([0-9]*\),.*/serial \1/p' "yk-$k.txt")" "$k"
done

# The secret half goes through a pipe only: from age-keygen straight into a file that only the two YubiKeys open.
age-keygen -pq 2> keygen.txt | age -R yk-recipients.txt -o seal-identity-g1.age
recipient=$(sed -n 's/^Public key: //p' keygen.txt)
rm keygen.txt
# The form the Worker takes (age1pq1, then 1,500 to 2,500 characters). The length apart: macOS bash 3.2 counts to 255 in a regex.
[[ "$recipient" =~ ^age1pq1[a-z0-9]+$ ]] && (( ${#recipient} >= 1507 && ${#recipient} <= 2507 )) \
  || stop "age-keygen gave no post-quantum recipient. Move $OUT away and run this again."
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
cat > README.txt <<EOF
Ophis business console, sealing key g1. Fingerprint (SHA-256 of ophis-recipient-g1.txt without its line end):
$fingerprint

Keep: seal-identity-g1.age (the key, locked to the two YubiKeys), yk-A.txt and yk-B.txt (which YubiKey and slot),
yk-recipients.txt. Two USB sticks, one with each YubiKey, in two places. Never iCloud, GitHub or Cloudflare.

Open a sealed item (Wi-Fi off, one YubiKey plugged in; PIN once, a touch):
  shasum -a 256 item.age      # must equal the SHA-256 that "operator get" printed
  age -d -i yk-A.txt seal-identity-g1.age | age -d -i - -o item.pdf item.age
Treat item.pdf as a file from a stranger, and delete it after use.

A YubiKey lost or broken: open the key with the other one and lock it to that one plus a new one. Nothing changes in
the console. (yk-new.txt from: age-plugin-yubikey --generate --name ophis-seal-C > yk-new.txt, the new key alone in.)
  age -d -i yk-A.txt seal-identity-g1.age | age -R <(sed -n 's/^# *Recipient: //p' yk-A.txt yk-new.txt) -o seal-identity-g1.new.age
EOF
cp ophis-recipient-g1.txt "$HERE/ophis-recipient-g1.txt"
printf '\nDone. Fingerprint of the sealing key:\n%s\n\n' "$fingerprint"
printf 'Next: copy %s to two USB sticks (one with each YubiKey), turn Wi-Fi on, and send the fingerprint above.\n' "$OUT"
printf 'The public half is in %s/ophis-recipient-g1.txt.\n' "$HERE"
