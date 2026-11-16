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

  // ---- The ceremony (scripts/seal-ceremony.sh): one YubiKey, and the key itself on paper (owner, 2026-11-16) ----
  // No YubiKey here: a stand-in age-plugin-yubikey gives a software X25519 key in its identity-file form. PATH is the
  // stand-in folder ONLY (the real tools linked in by full path), so the real plugin, installed on this Mac, is never
  // reached. The ceremony runs in a pseudo-terminal (tests/pty.py) that answers as the key holder does: Enter, Enter,
  // Enter once the key is on paper, then the key typed back from the paper (the one the script showed).
  const real = (tool) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
  const stubs = join(dir, 'stubs')
  if (stubs.includes(':')) throw new Error('a ":" in the folder would split PATH')
  mkdirSync(stubs)
  for (const tool of ['age', 'dirname', 'mkdir', 'sed', 'rm', 'cmp', 'cut', 'shasum', 'cat', 'cp', 'grep', 'tr', 'stty']) symlinkSync(real(tool), join(stubs, tool))
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  // As macOS route answers (seen 2026-11-16): a default route prints its "interface:" line; none prints "not in table"
  // on standard error, and the status is 0 either way. ROUTE4 or ROUTE6 set: that family has a default route.
  stub('pbcopy', 'cat > /dev/null; : > "$HOME/.clipboard-emptied"') // records that the clipboard was emptied
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
  const SHOWN = 'AGE-SECRET-KEY-PQ-1 ([0-9A-Z ]+?) *\\r?\\n' // the key as the script shows it, in groups of 4
  const TYPE = 'type the key from your paper'
  const answers = (typed = ['AGE-SECRET-KEY-PQ-1 {from}\n']) => [ENTER, ENTER, ENTER, ...typed.map((send) => ({ when: TYPE, from: SHOWN, send }))]
  // a terminal ends lines with \r\n
  const inPty = (rules, args, env) => { const run = spawnSync('/usr/bin/python3', ['-I', PTY, JSON.stringify(rules), ...args], { env, encoding: 'utf8' }); return { ...run, stdout: run.stdout.replaceAll('\r\n', '\n') } }
  // The stand-in's key is a software key: this copy widens the one hardware check, and nothing else.
  // mine: a README.txt of the operator's own is already next to the script; the run must leave it as it is (ToB).
  const ceremony = (name, { script = original.replace(HARDWARE, '^age1[02-9ac-hj-np-z]+$'), env = {}, typed, bash = ['/bin/bash'], mine = false } = {}) => {
    const home = join(dir, name), here = join(home, 'icloud')
    mkdirSync(here, { recursive: true })
    writeFileSync(join(here, 'seal-ceremony.sh'), script)
    if (mine) writeFileSync(join(here, 'README.txt'), 'MINE')
    const run = inPty(answers(typed), [...bash, join(here, 'seal-ceremony.sh')], { HOME: home, PATH: stubs, ...env })
    return { ...run, home, here, mine, out: join(home, 'ophis-seal-g1') }
  }
  const all = (folder) => readdirSync(folder, { recursive: true }).map((f) => join(folder, f)).filter((f) => statSync(f).isFile())
  const nothingKept = (run) => !existsSync(run.out) && JSON.stringify(readdirSync(run.here).sort()) === JSON.stringify(run.mine ? ['README.txt', 'seal-ceremony.sh'] : ['seal-ceremony.sh'])
    && (!run.mine || readFileSync(join(run.here, 'README.txt'), 'utf8') === 'MINE')
  const PQ_KEY = /AGE-SECRET-KEY-PQ-1[0-9A-Z]{40,}/ // a key itself (README.txt names the prefix in a recipe)

  const good = ceremony('good')
  const shown = new RegExp(SHOWN).exec(good.stdout)?.[1].replaceAll(' ', '') ?? ''
  const rawKey = `AGE-SECRET-KEY-PQ-1${shown}`
  check(`the ceremony runs to the end (${good.status}: ${good.stdout.trim().slice(-200)})`, good.status === 0 && shown.length === 58)
  const files = readdirSync(good.out).sort()
  check(`it leaves the YubiKey copy, the stub, the public half and README.txt, nothing else (${files})`,
    JSON.stringify(files) === JSON.stringify(['README.txt', 'ophis-recipient-g1.txt', 'seal-identity-g1.age', 'yk.txt']))
  const published = readFileSync(join(good.here, 'ophis-recipient-g1.txt'), 'utf8')
  const pq = published.trim()
  check('the public half next to the script is a hybrid recipient, the same as in the folder, and the shown key is its key',
    /^age1pq1[a-z0-9]{1500,2500}\n$/.test(published) && published === readFileSync(join(good.out, 'ophis-recipient-g1.txt'), 'utf8')
    && execFileSync(real('age-keygen'), ['-y'], { input: `${rawKey}\n`, encoding: 'utf8' }) === published)
  check('only the public half and a copy of README.txt, by a name of its own, are put next to the script', JSON.stringify(readdirSync(good.here).sort()) === JSON.stringify(['ophis-recipient-g1.txt', 'ophis-seal-g1-README.txt', 'seal-ceremony.sh']))
  check('the clipboard is emptied after the screen, in case the key was copied from it', existsSync(join(good.home, '.clipboard-emptied')))
  const fingerprint = createHash('sha256').update(pq).digest('hex')
  check('the printed fingerprint is the SHA-256 of the recipient string, as the console computes it, and README.txt has it',
    good.stdout.includes(`\n${fingerprint}\n`) && readFileSync(join(good.out, 'README.txt'), 'utf8').includes(fingerprint))
  check('the key is on no disk in clear', ![...all(good.out), ...all(good.here)].some((f) => PQ_KEY.test(readFileSync(f, 'latin1'))))
  check('the key is shown once, in groups, and never whole; then the screen is cleared', good.stdout.split(' '.repeat(3) + 'AGE-SECRET-KEY-PQ-1 ').length === 2 && !good.stdout.includes(shown)
    && good.stdout.indexOf('\x1b[2J\x1b[3J') > good.stdout.indexOf('AGE-SECRET-KEY-PQ-1 '))
  check('every file it made is readable by its owner only', all(good.out).every((f) => (statSync(f).mode & 0o077) === 0))
  check('it names the YubiKey by its serial', good.stdout.includes('YubiKey serial 12345671 is set up.'))
  check('it says to delete the folder from the laptop before going online', good.stdout.includes(`rm -rf ${good.out}) BEFORE Wi-Fi`))
  const traced = ceremony('traced', { bash: ['/bin/bash', '-x'] })
  const tracedKey = new RegExp(SHOWN).exec(traced.stdout)?.[1].replaceAll(' ', '') ?? 'none'
  check('run with bash -x, it still never prints the key whole', traced.status === 0 && !traced.stdout.includes(tracedKey))
  const retry = ceremony('retry', { typed: ['NOT THE KEY\n', 'AGE-SECRET-KEY-PQ-1 {from}\n'] })
  check('a key typed back wrong once can be typed again', retry.status === 0 && retry.stdout.includes('That is not the key'))
  // README.txt's recipes, as written there, in Terminal's shell: zsh, interactive, no startup files ("#" typed is no comment).
  const readme = readFileSync(join(good.out, 'README.txt'), 'utf8')
  const lines = readme.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())
  check('no README.txt command line carries a comment', lines.length > 0 && lines.every((line) => !/\s#/.test(line)))
  const zsh = (line) => ['/bin/zsh', '-f', '-i', '-c', `cd "$1" && ${line}`, '_', good.out]
  const shell = (line, env = {}) => spawnSync('/bin/zsh', zsh(line).slice(1), { env: { PATH: stubs, ...env }, encoding: 'utf8' })
  const typing = (line, typed, env = {}) => inPty([{ when: '', send: `${typed}\n\x04` }], zsh(line), { PATH: stubs, ...env }) // the key, Enter, Control-D
  const ram = join(dir, 'ram')
  mkdirSync(ram)
  const openWith = lines.filter((line) => line.includes('-o /Volumes/OphisRAM/item.pdf item.age'))
  check('README.txt opens an item onto its own RAM disk only (a name nothing else uses), with the YubiKey or the paper',
    openWith.length === 2 && lines.some((line) => line.startsWith('diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://')))
  // The whole chain: the console seals to the published recipient; README.txt opens it with the YubiKey and with the paper.
  const item = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const sealer = new Encrypter()
  sealer.addRecipient(pq)
  writeFileSync(join(good.out, 'item.age'), await sealer.encrypt(item))
  const byKey = shell(openWith[0].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'key.pdf')))
  check('README.txt opens what the console sealed, with the YubiKey', byKey.status === 0 && readFileSync(join(ram, 'key.pdf')).equals(item))
  const grouped = `AGE-SECRET-KEY-PQ-1 ${shown.replace(/.{4}/g, '$& ')}`
  const byPaper = typing(openWith[1].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'paper.pdf')), grouped)
  check('README.txt opens what the console sealed, with the key typed from the paper (in its groups)', byPaper.status === 0 && readFileSync(join(ram, 'paper.pdf')).equals(item))
  const byLower = typing(openWith[1].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'lower.pdf')), grouped.toLowerCase())
  check('and typed in small letters, as the ceremony\'s own check takes it (ToB)', byLower.status === 0 && readFileSync(join(ram, 'lower.pdf')).equals(item))
  // The YubiKey or the stick lost: its four lines, one at a time, as README.txt says (the check line widened as the script's).
  const lost = readme.slice(readme.indexOf('The YubiKey or the USB stick lost'), readme.indexOf('Then: seal-identity-g1.new.age')).split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().replace(`'^# *Recipient: age1yubikey1'`, `'^# *Recipient: age1'`))
  check('README.txt has the four lines of a new YubiKey copy', lost.length === 4)
  const lostText = readme.slice(readme.indexOf('The YubiKey or the USB stick lost'), readme.indexOf('The paper lost'))
  check('the new copy is never made in the iCloud folder (ToB)', lostText.includes('NEVER the iCloud folder') && !lostText.includes('the iCloud folder has it'))
  const said = [shell(lost[0]), shell(lost[1]), typing(lost[2], grouped.toLowerCase()), shell(lost[3])]
  check(`with them a new YubiKey opens the key, to the same recipient (${said.map((run) => run.status).join(' ')})`,
    said[0].status === 0 && said[1].stdout.trim() === 'go on' && said[2].status === 0 && said[3].stdout.trim() === 'the new YubiKey opens it')
  const wrongKey = [typing(lost[2], 'NOT THE KEY'), shell(lost[3])]
  check('a key typed wrong gives no new copy that the check accepts', !wrongKey[1].stdout.includes('opens it'))
  check('when the new YubiKey fails to generate, the check line says STOP', shell(lost[0], { FAIL: '1' }).status !== 0 && shell(lost[1]).stdout.trim() === 'STOP')
  // The paper lost: the YubiKey copy shows the key again.
  const again = lines.find((line) => line.startsWith('age -d -i yk.txt seal-identity-g1.age | grep')) ?? ''
  check('README.txt shows the key again from the YubiKey copy, for a new paper, and clears the screen after', shell(again).stdout.trim() === rawKey && lines.includes(`printf '\\033[2J\\033[3J\\033[H'`))

  // What stops it, and what it leaves: until the very end a stopped run takes back all it made (Clement's laptop,
  // 2026-11-16: a folder left behind by a failed YubiKey step stopped every run after it).
  const failed = ceremony('failed', { env: { FAIL: '1' }, mine: true })
  check('a YubiKey that cannot be set up stops it, says what macOS sees, and keeps nothing', failed.status !== 0 && failed.stdout.includes('The YubiKey was not set up') && failed.stdout.includes('macOS sees: no YubiKey') && nothingKept(failed))
  const rerun = inPty(answers(), ['/bin/bash', join(failed.here, 'seal-ceremony.sh')], { HOME: failed.home, PATH: stubs })
  check('run again after it, it goes to the end', rerun.status === 0 && existsSync(join(failed.out, 'seal-identity-g1.age')))
  const soft = ceremony('soft', { script: original })
  check('the script as written stops on a key that is not a YubiKey, and keeps nothing', soft.status !== 0 && soft.stdout.includes('gave no hardware recipient') && nothingKept(soft))
  const bad = ceremony('bad', { env: { BAD: '1' }, mine: true })
  const kept = ceremony('kept', { mine: true })
  check('a README.txt of the operator\'s own next to the script is left as it is by a run that ends (ToB)', kept.status === 0 && readFileSync(join(kept.here, 'README.txt'), 'utf8') === 'MINE')
  check('a YubiKey that cannot open the key stops it, and keeps nothing', bad.status !== 0 && bad.stdout.includes('The YubiKey did not open') && nothingKept(bad))
  const three = Array(3).fill('AGE-SECRET-KEY-PQ-1 {from}\n')
  const lie = ceremony('lie', { env: { LIE: '1' }, typed: three })
  check('a key that is not the one announced stops it, and keeps nothing', lie.status !== 0 && lie.stdout.includes('STOPPED') && nothingKept(lie))
  const typo = ceremony('typo', { typed: Array(3).fill('NOT THE KEY\n') })
  check('a key typed back wrong three times stops it, and keeps nothing', typo.status !== 0 && typo.stdout.includes('Three tries') && nothingKept(typo))
  for (const [name, env] of [['IPv4', { ROUTE4: '1' }], ['IPv6 only', { ROUTE6: '1' }]]) {
    const online = ceremony(`online-${name.replace(' ', '')}`, { env })
    check(`it stops while the laptop is online (${name}), before making anything`, online.status !== 0 && online.stdout.includes('is online') && nothingKept(online))
  }
  const readonly = ceremony('readonly-setup')
  rmSync(readonly.out, { recursive: true })
  for (const f of ['ophis-recipient-g1.txt', 'ophis-seal-g1-README.txt']) rmSync(join(readonly.here, f))
  chmodSync(readonly.here, 0o555)
  const blocked = inPty(answers(), ['/bin/bash', join(readonly.here, 'seal-ceremony.sh')], { HOME: readonly.home, PATH: stubs })
  chmodSync(readonly.here, 0o755)
  check('if the public half cannot be put next to the script, it stops and keeps nothing (Codex, ToB)', blocked.status !== 0 && blocked.stdout.includes('Nothing was kept') && nothingKept(readonly))
  // Another run going on, or a key made before: the folder is claimed at the start; the run stops and leaves it as it was.
  const busy = join(dir, 'busy')
  mkdirSync(join(busy, 'icloud'), { recursive: true })
  mkdirSync(join(busy, 'ophis-seal-g1'))
  writeFileSync(join(busy, 'ophis-seal-g1', 'seal-identity-g1.age'), 'KEEP')
  writeFileSync(join(busy, 'icloud', 'seal-ceremony.sh'), original)
  const second = inPty(answers(), ['/bin/bash', join(busy, 'icloud', 'seal-ceremony.sh')], { HOME: busy, PATH: stubs })
  check('with the key folder there (another run, or a key made before), it stops and leaves it as it was', second.status !== 0 && second.stdout.includes('exists already') && readFileSync(join(busy, 'ophis-seal-g1', 'seal-identity-g1.age'), 'utf8') === 'KEEP')
  // The key folder deleted from the laptop as told: the public half next to the script still stops a second key.
  const done = ceremony('done home')
  const published1 = readFileSync(join(done.here, 'ophis-recipient-g1.txt'), 'utf8')
  check('a home with a space: the delete line quotes the path', done.status === 0 && done.stdout.includes(`rm -rf ${done.out.replaceAll(' ', '\\ ')}) BEFORE`))
  rmSync(done.out, { recursive: true })
  const third = inPty(answers(), ['/bin/bash', join(done.here, 'seal-ceremony.sh')], { HOME: done.home, PATH: stubs })
  check('after the key folder is deleted, a second run stops on the public half and changes nothing', third.status !== 0 && third.stdout.includes('A key was made before')
    && !existsSync(done.out) && readFileSync(join(done.here, 'ophis-recipient-g1.txt'), 'utf8') === published1)
} catch (error) {
  check(`the run (${error.message}${/^spawnSync age(-keygen)? ENOENT/.test(error.message) ? ': brew install age' : ''})`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'The age tool opens what the console seals, and the ceremony works with stand-in keys.')
process.exitCode = failed ? 1 : 0
