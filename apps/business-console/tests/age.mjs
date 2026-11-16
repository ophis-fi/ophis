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
  for (const tool of ['age', 'dirname', 'mkdir', 'sed', 'rm', 'cmp', 'cut', 'shasum', 'cat', 'cp']) symlinkSync(real(tool), join(stubs, tool))
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  stub('route', 'exit "${ROUTE_EXIT:-1}"') // 1: no default route, as with Wi-Fi off
  // The real age-keygen, except with LIE set: "-pq" then names the public key of another identity than the one it gives.
  stub('age-keygen', [
    `[[ $1 == -pq && -n $LIE ]] || exec ${real('age-keygen')} "$@"`,
    `${real('age-keygen')} -pq 2>/dev/null`,
    `${real('age-keygen')} -pq 2>&1 >/dev/null | ${real('sed')} -n '/^Public key: /p' >&2`,
  ].join('\n'))
  // BAD=B: key B's file names the recipient of another key than its own (a stanza no key opens).
  stub('age-plugin-yubikey', [
    `[[ $1 == --version ]] && { echo "age-plugin-yubikey 0.5.1"; exit 0; }`,
    `[[ $1 == --generate ]] || exit 2`,
    `id=$(${real('age-keygen')} 2>/dev/null | ${real('sed')} -n '/^AGE-SECRET-KEY-1/p')`,
    `r=$(printf '%s\\n' "$id" | ${real('age-keygen')} -y)`,
    `[[ $3 == ophis-seal-$BAD ]] && r=$(${real('age-keygen')} 2>/dev/null | ${real('age-keygen')} -y)`,
    `printf '#       Serial: 1234567%s, Slot: 1\\n#         Name: %s\\n#    Recipient: %s\\n%s\\n' "\${3: -1}" "$3" "$r" "$id"`,
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
  // The whole chain: the console seals to the published recipient; README.txt's recipe opens it with either key.
  const item = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const sealer = new Encrypter()
  sealer.addRecipient(pq)
  writeFileSync(join(good.out, 'item.age'), await sealer.encrypt(item))
  for (const k of ['A', 'B']) {
    const recipe = spawnSync('/bin/bash', ['-c', `cd "$1" && age -d -i yk-${k}.txt seal-identity-g1.age | age -d -i - -o item-${k}.pdf item.age`, '_', good.out], { env: { PATH: stubs } })
    check(`README.txt's recipe opens what the console sealed, with key ${k}`, recipe.status === 0 && readFileSync(join(good.out, `item-${k}.pdf`)).equals(item))
  }

  const soft = ceremony('soft', { script: original })
  check('the script as written stops on a key that is not a YubiKey, before any key file', soft.status !== 0 && soft.stderr.includes('gave no hardware recipient') && !existsSync(join(soft.out, 'seal-identity-g1.age')))
  const online = ceremony('online', { env: { ROUTE_EXIT: '0' } })
  check('it stops while the laptop is online, before making anything', online.status !== 0 && online.stderr.includes('is online') && !existsSync(online.out))
  const again = ceremony('again')
  writeFileSync(join(again.out, 'seal-identity-g1.age'), 'KEEP')
  const rerun = spawnSync('/bin/bash', [join(again.here, 'seal-ceremony.sh')], { env: { HOME: again.home, PATH: stubs }, input: '\n'.repeat(6), encoding: 'utf8' })
  check('run again, it stops and leaves the key made before as it was', rerun.status !== 0 && rerun.stderr.includes('exists already') && readFileSync(join(again.out, 'seal-identity-g1.age'), 'utf8') === 'KEEP')
  const bad = ceremony('bad', { env: { BAD: 'B' } })
  check('a key that cannot open the key file stops it, and no public half is put next to the script', bad.status !== 0 && bad.stderr.includes('YubiKey B did not open') && !existsSync(join(bad.here, 'ophis-recipient-g1.txt')))
  const lie = ceremony('lie', { env: { LIE: '1' } })
  check('a key file that opens to another identity than the one announced stops it, and nothing is published', lie.status !== 0 && lie.stderr.includes('YubiKey B did not open') && !existsSync(join(lie.here, 'ophis-recipient-g1.txt')))
} catch (error) {
  check(`the run (${error.message}${/^spawnSync age(-keygen)? ENOENT/.test(error.message) ? ': brew install age' : ''})`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'The age tool opens what the console seals, and the ceremony works with stand-in keys.')
process.exitCode = failed ? 1 : 0
