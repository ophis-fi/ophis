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

  // ---- The ceremony (scripts/seal-ceremony.sh): one YubiKey and a paper backup (owner, 2026-11-16) ----
  // No YubiKey here: a stand-in age-plugin-yubikey gives a software X25519 key in its identity-file form. PATH is the
  // stand-in folder ONLY (the real tools linked in by full path), so the real plugin, installed on this Mac, is never
  // reached. The ceremony runs in a pseudo-terminal (tests/pty.py) that answers its prompts as the key holder does:
  // Enter, Enter, Enter at age's passphrase prompt (age makes one), Enter, then that passphrase typed back.
  const real = (tool) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
  const stubs = join(dir, 'stubs')
  if (stubs.includes(':')) throw new Error('a ":" in the folder would split PATH')
  mkdirSync(stubs)
  for (const tool of ['age', 'dirname', 'mkdir', 'mktemp', 'mv', 'sed', 'rm', 'cmp', 'cut', 'shasum', 'cat', 'cp', 'grep', 'tr']) symlinkSync(real(tool), join(stubs, tool))
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
  // The stand-in YubiKey, serial 12345671. FAIL: generating fails, with no output (as on Clement's laptop, 2026-11-16).
  // BAD: the file names the recipient of another key than its own (a stanza no key opens).
  stub('age-plugin-yubikey', [
    `[[ $1 == --version ]] && { echo "age-plugin-yubikey 0.5.1"; exit 0; }`,
    `[[ $1 == --generate ]] || exit 2`,
    `[[ -n $FAIL ]] && { echo "Error: stand-in YubiKey failure" >&2; exit 1; }`,
    `id=$(${real('age-keygen')} 2>/dev/null | ${real('sed')} -n '/^AGE-SECRET-KEY-1/p')`,
    `r=$(printf '%s\\n' "$id" | ${real('age-keygen')} -y)`,
    `[[ -n $BAD ]] && r=$(${real('age-keygen')} 2>/dev/null | ${real('age-keygen')} -y)`,
    `printf '#       Serial: 12345671, Slot: 1\\n#         Name: %s\\n#    Recipient: %s\\n%s\\n' "$3" "$r" "$id"`,
  ].join('\n'))
  const original = readFileSync('scripts/seal-ceremony.sh', 'utf8')
  const HARDWARE = '^age1yubikey1[02-9ac-hj-np-z]+$'
  check('the ceremony takes only a hardware recipient from the plugin (one check)', original.split(HARDWARE).length === 2)
  const PTY = join(process.cwd(), 'tests', 'pty.py')
  const ENTER = { when: 'Then press Enter\\. ', send: '\n' }
  const answers = (typed = '{pass}\n') => [ENTER, ENTER, { when: 'Enter passphrase \\(leave empty', send: '\n' }, ENTER, { when: 'Enter passphrase:', send: typed }]
  const inPty = (rules, args, env) => { const run = spawnSync('/usr/bin/python3', ['-I', PTY, JSON.stringify(rules), ...args], { env, encoding: 'utf8' }); return { ...run, stdout: run.stdout.replaceAll('\r\n', '\n') } } // a terminal ends lines with \r\n
  // The stand-in's key is a software key: this copy widens the one hardware check, and nothing else.
  const ceremony = (name, { script = original.replace(HARDWARE, '^age1[02-9ac-hj-np-z]+$'), env = {}, typed } = {}) => {
    const home = join(dir, name), here = join(home, 'icloud')
    mkdirSync(here, { recursive: true })
    writeFileSync(join(here, 'seal-ceremony.sh'), script)
    const run = inPty(answers(typed), ['/bin/bash', join(here, 'seal-ceremony.sh')], { HOME: home, PATH: stubs, ...env })
    return { ...run, home, here, out: join(home, 'ophis-seal-g1') }
  }
  const all = (folder) => readdirSync(folder, { recursive: true }).map((f) => join(folder, f)).filter((f) => statSync(f).isFile())
  const left = (run) => readdirSync(run.home).filter((f) => f.startsWith('.ophis-seal-work'))
  const nothingKept = (run) => !existsSync(run.out) && !existsSync(join(run.here, 'ophis-recipient-g1.txt')) && left(run).length === 0
  const PQ_SECRET = 'AGE-SECRET-KEY-PQ-'

  const good = ceremony('good')
  const pass = /autogenerated passphrase "([^"]+)"/.exec(good.stdout)?.[1] ?? ''
  check(`the ceremony runs to the end (${good.status}: ${good.stdout.trim().slice(-200)})`, good.status === 0 && pass !== '')
  const files = readdirSync(good.out).sort()
  check(`it leaves the YubiKey copy, the paper copy, the stub, the public half and README.txt, nothing else (${files})`,
    JSON.stringify(files) === JSON.stringify(['README.txt', 'ophis-recipient-g1.txt', 'seal-identity-g1.age', 'seal-identity-g1.paper.age', 'yk.txt']))
  check('no work folder is left in the home folder', left(good).length === 0)
  const published = readFileSync(join(good.here, 'ophis-recipient-g1.txt'), 'utf8')
  const pq = published.trim()
  check('the public half next to the script is a hybrid recipient, the same as in the folder', /^age1pq1[a-z0-9]{1500,2500}\n$/.test(published) && published === readFileSync(join(good.out, 'ophis-recipient-g1.txt'), 'utf8'))
  check('only the public half is put next to the script', JSON.stringify(readdirSync(good.here).sort()) === JSON.stringify(['ophis-recipient-g1.txt', 'seal-ceremony.sh']))
  const fingerprint = createHash('sha256').update(pq).digest('hex')
  check('the printed fingerprint is the SHA-256 of the recipient string, as the console computes it, and README.txt has it',
    good.stdout.includes(`\n${fingerprint}\n`) && readFileSync(join(good.out, 'README.txt'), 'utf8').includes(fingerprint))
  check('the post-quantum secret is on no disk in clear and in no output', ![...all(good.out), ...all(good.here)].some((f) => readFileSync(f, 'latin1').includes(PQ_SECRET)) && !good.stdout.includes(PQ_SECRET))
  check('every file it made is readable by its owner only', all(good.out).every((f) => (statSync(f).mode & 0o077) === 0))
  check('it names the YubiKey by its serial, and clears the screen once the passphrase is on paper', good.stdout.includes('YubiKey serial 12345671 is set up.') && good.stdout.includes('\x1b[2J\x1b[3J'))
  check('it says to delete the folder from the laptop before going online', good.stdout.includes(`rm -rf ${good.out}) BEFORE Wi-Fi`))
  // README.txt's recipes, as written there, in Terminal's shell: zsh, interactive, no startup files ("#" typed is no comment).
  const readme = readFileSync(join(good.out, 'README.txt'), 'utf8')
  const lines = readme.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())
  check('no README.txt command line carries a comment', lines.length > 0 && lines.every((line) => !/\s#/.test(line)))
  const zsh = (line, env = {}) => ['/bin/zsh', '-f', '-i', '-c', `cd "$1" && ${line}`, '_', good.out]
  const shell = (line, env = {}) => spawnSync(zsh(line)[0], zsh(line).slice(1), { env: { PATH: stubs, ...env }, encoding: 'utf8' })
  const typing = (line, typed, env = {}) => inPty([{ when: 'Enter passphrase:', send: `${typed}\n` }], zsh(line), { PATH: stubs, ...env })
  const ram = join(dir, 'ram')
  mkdirSync(ram)
  const openWith = lines.filter((line) => line.endsWith('-o /Volumes/OphisRAM/item.pdf item.age'))
  check('README.txt opens an item onto its own RAM disk only (a name nothing else uses), with the YubiKey or the paper',
    openWith.length === 2 && lines.some((line) => line.startsWith('diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://')))
  // The whole chain: the console seals to the published recipient; README.txt opens it with the YubiKey and with the paper.
  const item = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const sealer = new Encrypter()
  sealer.addRecipient(pq)
  writeFileSync(join(good.out, 'item.age'), await sealer.encrypt(item))
  const byKey = shell(openWith[0].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'key.pdf')))
  check('README.txt opens what the console sealed, with the YubiKey', byKey.status === 0 && readFileSync(join(ram, 'key.pdf')).equals(item))
  const byPaper = typing(openWith[1].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'paper.pdf')), pass)
  check('README.txt opens what the console sealed, with the passphrase from the paper', byPaper.status === 0 && readFileSync(join(ram, 'paper.pdf')).equals(item))
  // The YubiKey lost: its four lines, one at a time, as README.txt says (the check line widened as the script's).
  const lost = readme.slice(readme.indexOf('The YubiKey lost or broken'), readme.indexOf('Then: seal-identity-g1.new.age')).split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().replace(`'^# *Recipient: age1yubikey1'`, `'^# *Recipient: age1'`))
  check('README.txt has the four lines of a lost YubiKey', lost.length === 4)
  const said = [shell(lost[0]), shell(lost[1]), typing(lost[2], pass), shell(lost[3])].map((run) => (run.status === 0 ? run.stdout.trim() : `exit ${run.status}`))
  check(`with them a new YubiKey opens the key, to the same recipient (${said.map((s) => s.slice(-40)).join(' | ')})`,
    said[0] === '' && said[1] === 'go on' && said[2].endsWith('Enter passphrase:') === false && said[3] === 'the new YubiKey opens it')
  const wrongPaper = [typing(lost[2], 'not-the-words'), shell(lost[3])]
  check('a wrong passphrase gives a new file that the check does not accept', !wrongPaper[1].stdout.includes('opens it'))
  check('when the new YubiKey fails to generate, the check line says STOP', shell(lost[0], { FAIL: '1' }).status !== 0 && shell(lost[1]).stdout.trim() === 'STOP')

  // What stops it, and what it leaves: a stopped run keeps nothing (Clement's laptop, 2026-11-16: a folder left behind
  // by a failed YubiKey step stopped every run after it).
  const failed = ceremony('failed', { env: { FAIL: '1' } })
  check('a YubiKey that cannot be set up stops it, says what macOS sees, and keeps nothing', failed.status !== 0 && failed.stdout.includes('The YubiKey was not set up') && failed.stdout.includes('macOS sees: no YubiKey') && nothingKept(failed))
  const retry = inPty(answers(), ['/bin/bash', join(failed.here, 'seal-ceremony.sh')], { HOME: failed.home, PATH: stubs })
  check('run again after it, it goes to the end', retry.status === 0 && existsSync(join(failed.out, 'seal-identity-g1.age')))
  const soft = ceremony('soft', { script: original })
  check('the script as written stops on a key that is not a YubiKey, and keeps nothing', soft.status !== 0 && soft.stdout.includes('gave no hardware recipient') && nothingKept(soft))
  const bad = ceremony('bad', { env: { BAD: '1' } })
  check('a YubiKey that cannot open the key stops it, and keeps nothing', bad.status !== 0 && bad.stdout.includes('The YubiKey did not open') && nothingKept(bad))
  const lie = ceremony('lie', { env: { LIE: '1' } })
  check('a key that opens to another identity than the one announced stops it, and keeps nothing', lie.status !== 0 && lie.stdout.includes('The YubiKey did not open') && nothingKept(lie))
  const typo = ceremony('typo', { typed: 'not-the-words\n' })
  check('a passphrase typed back wrong stops it, and keeps nothing', typo.status !== 0 && typo.stdout.includes('did not open the paper copy') && nothingKept(typo))
  for (const [name, env] of [['IPv4', { ROUTE4: '1' }], ['IPv6 only', { ROUTE6: '1' }]]) {
    const online = ceremony(`online-${name.replace(' ', '')}`, { env })
    check(`it stops while the laptop is online (${name}), before making anything`, online.status !== 0 && online.stdout.includes('is online') && nothingKept(online))
  }
  const again = ceremony('again')
  writeFileSync(join(again.out, 'seal-identity-g1.age'), 'KEEP')
  const rerun = inPty(answers(), ['/bin/bash', join(again.here, 'seal-ceremony.sh')], { HOME: again.home, PATH: stubs })
  check('run again with the key folder there, it stops and leaves it as it was', rerun.status !== 0 && rerun.stdout.includes('exists already') && readFileSync(join(again.out, 'seal-identity-g1.age'), 'utf8') === 'KEEP')
  // The key folder deleted from the laptop as told: the public half next to the script still stops a second key.
  const done = ceremony('done home')
  const published1 = readFileSync(join(done.here, 'ophis-recipient-g1.txt'), 'utf8')
  check('a home with a space: the delete line quotes the path', done.status === 0 && done.stdout.includes(`rm -rf ${done.out.replaceAll(' ', '\\ ')}) BEFORE`))
  rmSync(done.out, { recursive: true })
  const second = inPty(answers(), ['/bin/bash', join(done.here, 'seal-ceremony.sh')], { HOME: done.home, PATH: stubs })
  check('after the key folder is deleted, a second run stops on the public half and changes nothing', second.status !== 0 && second.stdout.includes('A key was made before')
    && !existsSync(done.out) && readFileSync(join(done.here, 'ophis-recipient-g1.txt'), 'utf8') === published1)
} catch (error) {
  check(`the run (${error.message}${/^spawnSync age(-keygen)? ENOENT/.test(error.message) ? ': brew install age' : ''})`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'The age tool opens what the console seals, and the ceremony works with stand-in keys.')
process.exitCode = failed ? 1 : 0
