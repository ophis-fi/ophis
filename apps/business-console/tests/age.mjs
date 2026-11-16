// On demand (pnpm test:age), needs the `age` tool 1.3 or later (brew install age). Interop, key-custody.md section 3:
// what the console seals in the browser (age-encryption 0.3.1, the same call as onboarding.tsx `sealed()`) to a key
// made by the `age` tool, as the security-key ceremony makes the real one (age-keygen -pq), is opened by the `age`
// tool with that key, byte for byte, and passes the Worker's own upload check. Another key cannot open it.
// Then the ceremony, scripts/seal-ceremony.sh, with stand-in keys (below). The keys are made in a temporary folder that
// is removed after; nothing is printed of them.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Encrypter } from 'age-encryption'
import { sealedShape } from '../src/server/onboarding.ts'

let failed = false
const check = (name, ok) => { failed ||= !ok; console.log(`${ok ? 'ok  ' : 'FAILED'} ${name}`) }
const dir = mkdtempSync(join(tmpdir(), 'age-interop-'))
try {
  const version = execFileSync('age', ['--version'], { encoding: 'utf8' }).trim()
  check(`the age tool is 1.3 or later (${version})`, /^v1\.([3-9]|\d{2,})\./.test(version))
  // As the ceremony does: the identity goes to a file here (to the hardware-wrapped file there); "Public key:" goes to standard error.
  const keygen = spawnSync('age-keygen', ['-pq', '-o', join(dir, 'id')], { encoding: 'utf8' })
  const recipient = /^Public key: (age1pq1[a-z0-9]+)$/m.exec(keygen.stderr)?.[1] ?? ''
  check('age-keygen -pq gives a hybrid recipient of the form the Worker accepts', keygen.status === 0 && /^age1pq1[a-z0-9]{1500,2500}$/.test(recipient))
  check('age-keygen -y gives the same recipient back from the identity', execFileSync('age-keygen', ['-y', join(dir, 'id')], { encoding: 'utf8' }).trim() === recipient)
  const clear = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(200_000)]) // over three 64 KiB chunks
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const sealed = await encrypter.encrypt(clear)
  check('the sealed file passes the Worker\'s upload check (one hybrid stanza, 1,627-byte header)', sealedShape(sealed))
  writeFileSync(join(dir, 'item.age'), sealed)
  const opened = spawnSync('age', ['-d', '-i', join(dir, 'id'), join(dir, 'item.age')])
  check('the age tool opens it with the identity, equal to the clear file', opened.status === 0 && Buffer.from(opened.stdout).equals(clear))
  spawnSync('age-keygen', ['-pq', '-o', join(dir, 'other')])
  check('another hybrid identity cannot open it', spawnSync('age', ['-d', '-i', join(dir, 'other'), join(dir, 'item.age')]).status !== 0)
  const cut = Buffer.from(readFileSync(join(dir, 'item.age')))
  cut[cut.length - 1] ^= 1
  writeFileSync(join(dir, 'cut.age'), cut)
  check('a file changed by one bit is refused', spawnSync('age', ['-d', '-i', join(dir, 'id'), join(dir, 'cut.age')]).status !== 0)

  // ---- The ceremony (scripts/seal-ceremony.sh), with stand-in keys ----
  // No YubiKey here: a stand-in age-plugin-yubikey gives a software X25519 key in its identity-file form. PATH is the
  // stand-in folder ONLY (the real tools linked in by full path), so the real plugin, installed on this Mac, is never reached.
  const real = (tool) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
  const stubs = join(dir, 'stubs')
  if (stubs.includes(':')) throw new Error('a ":" in the folder would split PATH')
  mkdirSync(stubs)
  for (const tool of ['age', 'dirname', 'mkdir', 'sed', 'rm', 'cmp', 'cut', 'shasum', 'cat', 'cp', 'grep']) symlinkSync(real(tool), join(stubs, tool))
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  // As macOS route answers (seen 2026-11-16): a default route prints its "interface:" line; none prints "not in table"
  // on standard error, and the status is 0 either way. ROUTE4 or ROUTE6 set: that family has a default route.
  stub('route', [
    `if [[ " $* " == *" -inet6 "* ]]; then up=$ROUTE6; else up=$ROUTE4; fi`,
    `if [[ -n $up ]]; then printf '   route to: default\\n  interface: en0\\n'; else echo 'route: writing to routing socket: not in table' >&2; fi`,
    'exit 0',
  ].join('\n'))
  // The real age-keygen, except with LIE set: "-pq" then names the public key of another identity than the one it gives.
  stub('age-keygen', [
    `[[ $1 == -pq && -n $LIE ]] || exec ${real('age-keygen')} "$@"`,
    `${real('age-keygen')} -pq 2>/dev/null`,
    `${real('age-keygen')} -pq 2>&1 >/dev/null | ${real('sed')} -n '/^Public key: /p' >&2`,
  ].join('\n'))
  // Serial 1234567 and 1 for A, 2 for B, 3 for C. BAD=B: key B's file names the recipient of another key than its own
  // (a stanza no key opens). SAME=1: B has A's serial (A left in). FAIL=A: generating A fails, with no output.
  stub('age-plugin-yubikey', [
    `[[ $1 == --version ]] && { echo "age-plugin-yubikey 0.5.1"; exit 0; }`,
    `[[ $1 == --generate ]] || exit 2`,
    `[[ $3 == ophis-seal-$FAIL ]] && exit 1`,
    `id=$(${real('age-keygen')} 2>/dev/null | ${real('sed')} -n '/^AGE-SECRET-KEY-1/p')`,
    `r=$(printf '%s\\n' "$id" | ${real('age-keygen')} -y)`,
    `[[ $3 == ophis-seal-$BAD ]] && r=$(${real('age-keygen')} 2>/dev/null | ${real('age-keygen')} -y)`,
    `case $3 in *A) n=1 ;; *B) n=2 ;; *) n=3 ;; esac; [[ -n $SAME ]] && n=1`,
    `printf '#       Serial: 1234567%s, Slot: 1\\n#         Name: %s\\n#    Recipient: %s\\n%s\\n' "$n" "$3" "$r" "$id"`,
  ].join('\n'))
  const original = readFileSync('scripts/seal-ceremony.sh', 'utf8')
  const HARDWARE = '^age1yubikey1[02-9ac-hj-np-z]+$'
  check('the ceremony takes only hardware recipients from the plugin (one check)', original.split(HARDWARE).length === 2)
  // The stand-in's keys are software keys: this copy widens that one check, and nothing else.
  const ceremony = (name, { script = original.replace(HARDWARE, '^age1[02-9ac-hj-np-z]+$'), env = {} } = {}) => {
    const home = join(dir, name), here = join(home, 'icloud')
    mkdirSync(here, { recursive: true })
    writeFileSync(join(here, 'seal-ceremony.sh'), script)
    const run = spawnSync('/bin/bash', [join(here, 'seal-ceremony.sh')], { env: { HOME: home, PATH: stubs, ...env }, input: '\n'.repeat(6), encoding: 'utf8' })
    return { ...run, home, here, out: join(home, 'ophis-seal-g1') }
  }
  const all = (folder) => readdirSync(folder, { recursive: true }).map((f) => join(folder, f)).filter((f) => statSync(f).isFile())
  const PQ_SECRET = 'AGE-SECRET-KEY-PQ-'

  const good = ceremony('good')
  check(`the ceremony runs to the end (${good.status}: ${good.stderr.trim().slice(-200)})`, good.status === 0)
  const files = readdirSync(good.out).sort()
  check(`it leaves the key file, both stubs, the recipients, the public half and README.txt, nothing else (${files})`,
    JSON.stringify(files) === JSON.stringify(['README.txt', 'ophis-recipient-g1.txt', 'seal-identity-g1.age', 'yk-A.txt', 'yk-B.txt', 'yk-recipients.txt']))
  const published = readFileSync(join(good.here, 'ophis-recipient-g1.txt'), 'utf8')
  const pq = published.trim()
  check('the public half next to the script is a hybrid recipient, the same as in the folder', /^age1pq1[a-z0-9]{1500,2500}\n$/.test(published) && published === readFileSync(join(good.out, 'ophis-recipient-g1.txt'), 'utf8'))
  check('only the public half is put next to the script', JSON.stringify(readdirSync(good.here).sort()) === JSON.stringify(['ophis-recipient-g1.txt', 'seal-ceremony.sh']))
  const fingerprint = createHash('sha256').update(pq).digest('hex')
  check('the printed fingerprint is the SHA-256 of the recipient string, as the console computes it, and README.txt has it',
    good.stdout.includes(`\n${fingerprint}\n`) && readFileSync(join(good.out, 'README.txt'), 'utf8').includes(fingerprint))
  check('the key file is locked to both keys (two recipients)', readFileSync(join(good.out, 'yk-recipients.txt'), 'utf8').trim().split('\n').length === 2)
  check('the post-quantum secret is on no disk in clear and in no output', ![...all(good.out), ...all(good.here)].some((f) => readFileSync(f, 'latin1').includes(PQ_SECRET)) && !`${good.stdout}${good.stderr}`.includes(PQ_SECRET))
  check('every file it made is readable by its owner only', all(good.out).every((f) => (statSync(f).mode & 0o077) === 0))
  check('it names each key by its own serial', good.stdout.includes('YubiKey A is serial 12345671.') && good.stdout.includes('YubiKey B is serial 12345672.'))
  check('it says to delete the folder from the laptop before going online', good.stdout.includes(`rm -rf ${good.out}) BEFORE Wi-Fi`))
  // README.txt's recipes, run as written there (the RAM disk is a folder here; the stand-in keys are software keys).
  const readme = readFileSync(join(good.out, 'README.txt'), 'utf8')
  const lines = readme.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())
  const shell = (line, env = {}) => spawnSync('/bin/bash', ['-c', `cd "$1" && ${line}`, '_', good.out], { env: { PATH: stubs, ...env }, encoding: 'utf8' })
  const ram = join(dir, 'ram')
  mkdirSync(ram)
  const open = lines.find((line) => line.startsWith('age -d -i yk-A.txt seal-identity-g1.age | age -d -i - -o /Volumes/ram/item.pdf item.age')) ?? ''
  check('README.txt opens an item onto the RAM disk only', open !== '' && lines.some((line) => line.startsWith('diskutil erasevolume APFS ram $(hdiutil attach -nomount ram://')))
  // The whole chain: the console seals to the published recipient; README.txt's recipe opens it with either key.
  const item = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const sealer = new Encrypter()
  sealer.addRecipient(pq)
  writeFileSync(join(good.out, 'item.age'), await sealer.encrypt(item))
  for (const k of ['A', 'B']) {
    const recipe = shell(open.replaceAll('yk-A.txt', `yk-${k}.txt`).replace('/Volumes/ram/item.pdf', join(ram, `item-${k}.pdf`)))
    check(`README.txt's recipe opens what the console sealed, with key ${k}`, recipe.status === 0 && readFileSync(join(ram, `item-${k}.pdf`)).equals(item))
  }
  // The lost key: its six lines, one at a time, as the README says (its count is of YubiKey recipients: widened as above).
  const lost = readme.slice(readme.indexOf('A YubiKey lost'), readme.indexOf('Both must say so')).split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().replace(`'^age1yubikey1'`, `'^age1'`))
  check('README.txt has the six lines of a lost key', lost.length === 6)
  const said = lost.map((line) => shell(line)).map((run) => (run.status === 0 ? run.stdout.trim() : `exit ${run.status}`))
  check(`with them the key file opens with A and with the new key C, to the same recipient (${said.join(' | ')})`,
    JSON.stringify(said) === JSON.stringify(['', '', '2', '', 'A opens it', 'C opens it']))
  // Codex P1: the one left cannot open the key file (no pipefail in a plain shell): the new file holds nothing, and its checks say so.
  writeFileSync(join(good.out, 'yk-X.txt'), execFileSync(real('age-keygen'), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  const empty = [shell(lost[3].replace('-i yk-A.txt', '-i yk-X.txt')), shell(lost[4]), shell(lost[5])]
  check('a re-lock by a key that cannot open the file gives a file that neither check accepts', empty[0].status === 0 && !empty[1].stdout.includes('opens it') && !empty[2].stdout.includes('opens it'))
  const noC = shell(lost[0], { FAIL: 'C' })
  check('when the new key fails to generate, the count line says 1, not 2', noC.status !== 0 && shell(lost[1]).status === 0 && shell(lost[2]).stdout.trim() === '1')

  const soft = ceremony('soft', { script: original })
  check('the script as written stops on a key that is not a YubiKey, before any key file', soft.status !== 0 && soft.stderr.includes('gave no hardware recipient') && !existsSync(join(soft.out, 'seal-identity-g1.age')))
  for (const [name, env] of [['IPv4', { ROUTE4: '1' }], ['IPv6 only', { ROUTE6: '1' }]]) {
    const online = ceremony(`online-${name.replace(' ', '')}`, { env })
    check(`it stops while the laptop is online (${name}), before making anything`, online.status !== 0 && online.stderr.includes('is online') && !existsSync(online.out))
  }
  const again = ceremony('again')
  writeFileSync(join(again.out, 'seal-identity-g1.age'), 'KEEP')
  const rerun = spawnSync('/bin/bash', [join(again.here, 'seal-ceremony.sh')], { env: { HOME: again.home, PATH: stubs }, input: '\n'.repeat(6), encoding: 'utf8' })
  check('run again, it stops and leaves the key made before as it was', rerun.status !== 0 && rerun.stderr.includes('exists already') && readFileSync(join(again.out, 'seal-identity-g1.age'), 'utf8') === 'KEEP')
  const bad = ceremony('bad', { env: { BAD: 'B' } })
  check('a key that cannot open the key file stops it, and no public half is put next to the script', bad.status !== 0 && bad.stderr.includes('YubiKey B did not open') && !existsSync(join(bad.here, 'ophis-recipient-g1.txt')))
  const same = ceremony('same', { env: { SAME: '1' } })
  check('the same YubiKey twice (A left in at step B) stops it, before any key file', same.status !== 0 && same.stderr.includes('That was YubiKey A again') && !existsSync(join(same.out, 'seal-identity-g1.age')))
  const broke = ceremony('broke', { env: { FAIL: 'A' } })
  check('a step that fails says so, and nothing is published', broke.status !== 0 && broke.stderr.includes('the step above failed') && !existsSync(join(broke.here, 'ophis-recipient-g1.txt')))
  const lie = ceremony('lie', { env: { LIE: '1' } })
  check('a key file that opens to another identity than the one announced stops it, and nothing is published', lie.status !== 0 && lie.stderr.includes('YubiKey B did not open') && !existsSync(join(lie.here, 'ophis-recipient-g1.txt')))
} catch (error) {
  check(`the run (${error.message}${/^spawnSync age(-keygen)? ENOENT/.test(error.message) ? ': brew install age' : ''})`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'The age tool opens what the console seals, and the ceremony works with stand-in keys.')
process.exitCode = failed ? 1 : 0
