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

  // ---- The ceremony (scripts/seal-ceremony.sh): no YubiKey, the key itself on two papers (owner, 2026-11-16) ----
  // PATH is the stand-in folder ONLY (the real tools linked in by full path), so nothing on this Mac but those is
  // reached. The ceremony runs in a pseudo-terminal (tests/pty.py) that answers as the key holder does: Enter, Enter
  // once the key is on both papers, then the key typed back from each paper (the one the script showed).
  const real = (tool) => execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
  const stubs = join(dir, 'stubs')
  if (stubs.includes(':')) throw new Error('a ":" in the folder would split PATH')
  mkdirSync(stubs)
  for (const tool of ['age', 'dirname', 'sed', 'rm', 'cmp', 'cut', 'shasum', 'cat', 'grep', 'tr', 'stty']) symlinkSync(real(tool), join(stubs, tool))
  const stub = (name, body) => { writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`); chmodSync(join(stubs, name), 0o755) }
  // The real mkdir, except with RACE set to a file: it is written first, as another run that ended just before this claim.
  stub('mkdir', `[[ -n $RACE ]] && printf 'age1pq1other\\n' > "$RACE"\nexec ${real('mkdir')} "$@"`)
  // The real cp, except with CP_FAIL set: the copy of the public half next to the script fails (the README copy before it does not).
  stub('cp', `[[ -n $CP_FAIL && $2 == */ophis-recipient-g1.txt && $2 != "$PWD/"* ]] && exit 1\nexec ${real('cp')} "$@"`)
  stub('pbcopy', 'cat > /dev/null; : > "$HOME/.clipboard-emptied"') // records that the clipboard was emptied
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
  // A stand-in YubiKey for README.txt's "later, a YubiKey 5" recipe (serial 12345671). The ceremony itself must never
  // call it: PLUGIN_MARK records any call. FAIL: generating fails, with no output.
  stub('age-plugin-yubikey', [
    `[[ -n $PLUGIN_MARK ]] && : > "$PLUGIN_MARK"`,
    `[[ $1 == --version ]] && { echo "age-plugin-yubikey 0.5.1"; exit 0; }`,
    `[[ $1 == --generate ]] || exit 2`,
    `[[ -n $FAIL ]] && { echo "Error: stand-in YubiKey failure" >&2; exit 1; }`,
    `id=$(${real('age-keygen')} 2>/dev/null | ${real('sed')} -n '/^AGE-SECRET-KEY-1/p')`,
    `r=$(printf '%s\\n' "$id" | ${real('age-keygen')} -y)`,
    `printf '#       Serial: 12345671, Slot: 1\\n#         Name: %s\\n#    Recipient: %s\\n%s\\n' "$3" "$r" "$id"`,
  ].join('\n'))
  const original = readFileSync('scripts/seal-ceremony.sh', 'utf8')
  const PTY = join(process.cwd(), 'tests', 'pty.py')
  const ENTER = { when: 'Then press Enter\\. ', send: '\n' }
  const SHOWN = 'AGE-SECRET-KEY-PQ-1 ([0-9A-Z ]+?) *\\r?\\n' // the key as the script shows it, in groups of 4
  const RIGHT = 'AGE-SECRET-KEY-PQ-1 {from}\n'
  const answers = (typed = [RIGHT, RIGHT]) => [ENTER, ENTER, ...typed.map((send) => ({ when: 'type the key from paper', from: SHOWN, send }))]
  // a terminal ends lines with \r\n
  const inPty = (rules, args, env) => { const run = spawnSync('/usr/bin/python3', ['-I', PTY, JSON.stringify(rules), ...args], { env, encoding: 'utf8' }); return { ...run, stdout: run.stdout.replaceAll('\r\n', '\n') } }
  // mine: a README.txt of the operator's own is already next to the script; the run must leave it as it is.
  const ceremony = (name, { env = {}, typed, bash = ['/bin/bash'], mine = false } = {}) => {
    const home = join(dir, name), here = join(home, 'icloud')
    mkdirSync(here, { recursive: true })
    writeFileSync(join(here, 'seal-ceremony.sh'), original)
    if (mine) writeFileSync(join(here, 'README.txt'), 'MINE')
    const run = inPty(answers(typed), [...bash, join(here, 'seal-ceremony.sh')], { HOME: home, PATH: stubs, PLUGIN_MARK: join(home, '.plugin-called'), ...env })
    return { ...run, home, here, mine, work: join(home, '.ophis-seal-g1.run') }
  }
  const all = (folder) => readdirSync(folder, { recursive: true }).map((f) => join(folder, f)).filter((f) => statSync(f).isFile())
  const nothingKept = (run) => !existsSync(run.work) && JSON.stringify(readdirSync(run.here).sort()) === JSON.stringify(run.mine ? ['README.txt', 'seal-ceremony.sh'] : ['seal-ceremony.sh'])
    && (!run.mine || readFileSync(join(run.here, 'README.txt'), 'utf8') === 'MINE')
  const PQ_KEY = /AGE-SECRET-KEY-PQ-1[0-9A-Z]{40,}/ // a key itself (README.txt names the prefix in a recipe)

  const good = ceremony('good')
  const shown = new RegExp(SHOWN).exec(good.stdout)?.[1].replaceAll(' ', '') ?? ''
  const rawKey = `AGE-SECRET-KEY-PQ-1${shown}`
  check(`the ceremony runs to the end (${good.status}: ${good.stdout.trim().slice(-200)})`, good.status === 0 && shown.length === 58)
  check('next to the script: the public half and the README copy only; the work folder is gone', JSON.stringify(readdirSync(good.here).sort()) === JSON.stringify(['ophis-recipient-g1.txt', 'ophis-seal-g1-README.txt', 'seal-ceremony.sh']) && !existsSync(good.work))
  check('no YubiKey is used: the plugin is never called', !existsSync(join(good.home, '.plugin-called')))
  const published = readFileSync(join(good.here, 'ophis-recipient-g1.txt'), 'utf8')
  const pq = published.trim()
  check('the public half is a hybrid recipient, and the shown key is its key',
    /^age1pq1[a-z0-9]{1500,2500}\n$/.test(published) && execFileSync(real('age-keygen'), ['-y'], { input: `${rawKey}\n`, encoding: 'utf8' }) === published)
  const fingerprint = createHash('sha256').update(pq).digest('hex')
  const readme = readFileSync(join(good.here, 'ophis-seal-g1-README.txt'), 'utf8')
  check('the printed fingerprint is the SHA-256 of the recipient string, as the console computes it, and README.txt has it', good.stdout.includes(`\n${fingerprint}\n`) && readme.includes(fingerprint))
  check('the key is on no disk in clear (the home folder and the script\'s folder)', !all(good.home).some((f) => PQ_KEY.test(readFileSync(f, 'latin1'))))
  check('the key is shown once, in groups, and never whole; then the screen is cleared', good.stdout.split(' '.repeat(3) + 'AGE-SECRET-KEY-PQ-1 ').length === 2 && !good.stdout.includes(shown)
    && good.stdout.indexOf('\x1b[2J\x1b[3J') > good.stdout.indexOf('AGE-SECRET-KEY-PQ-1 '))
  check('the clipboard is emptied after the screen, in case the key was copied from it', existsSync(join(good.home, '.clipboard-emptied')))
  check('both papers are checked', good.stdout.includes('Paper 1 gives the key.') && good.stdout.includes('Paper 2 gives the key.'))
  check('the files it put next to the script are readable by their owner only', ['ophis-recipient-g1.txt', 'ophis-seal-g1-README.txt'].every((f) => (statSync(join(good.here, f)).mode & 0o077) === 0))
  const traced = ceremony('traced', { bash: ['/bin/bash', '-x'] })
  const tracedKey = new RegExp(SHOWN).exec(traced.stdout)?.[1].replaceAll(' ', '') ?? 'none'
  check('run with bash -x, it still never prints the key whole', traced.status === 0 && !traced.stdout.includes(tracedKey))
  const piped = ceremony('piped', { bash: ['/bin/bash', '-c', 'set -o pipefail; /bin/bash "$0" | cat'] })
  check('piped or logged (| tee log), it stops before making anything: the key is shown on a terminal only', piped.status !== 0 && piped.stdout.includes('not piped or logged') && nothingKept(piped))
  const retry = ceremony('retry', { typed: ['NOT THE KEY\n', RIGHT, RIGHT] })
  check('a key typed back wrong once can be typed again', retry.status === 0 && retry.stdout.includes('That is not the key'))
  // README.txt's recipes, as written there, in Terminal's shell: zsh, interactive, no startup files ("#" typed is no comment).
  const lines = readme.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim())
  check('no README.txt command line carries a comment', lines.length > 0 && lines.every((line) => !/\s#/.test(line)))
  const rec = join(dir, 'recipes')
  mkdirSync(rec)
  writeFileSync(join(rec, 'ophis-recipient-g1.txt'), published)
  const zsh = (line) => ['/bin/zsh', '-f', '-i', '-c', `cd "$1" && ${line}`, '_', rec]
  const shell = (line, env = {}) => spawnSync('/bin/zsh', zsh(line).slice(1), { env: { PATH: stubs, ...env }, encoding: 'utf8' })
  const typing = (line, typed, env = {}) => inPty([{ when: '', send: `${typed}\n\x04` }], zsh(line), { PATH: stubs, ...env }) // the key, Enter, Control-D
  const ram = join(dir, 'ram')
  mkdirSync(ram)
  const openWith = lines.filter((line) => line.includes('-o /Volumes/OphisRAM/item.pdf item.age'))
  check('README.txt opens an item onto its own RAM disk only (a name nothing else uses), from a paper, or later a YubiKey',
    openWith.length === 2 && lines.some((line) => line.startsWith('diskutil erasevolume APFS OphisRAM $(hdiutil attach -nomount ram://')))
  // The whole chain: the console seals to the published recipient; README.txt opens it with the key typed from a paper.
  const item = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(5000)])
  const sealer = new Encrypter()
  sealer.addRecipient(pq)
  writeFileSync(join(rec, 'item.age'), await sealer.encrypt(item))
  const grouped = `AGE-SECRET-KEY-PQ-1 ${shown.replace(/.{4}/g, '$& ')}`
  const byPaper = typing(openWith[0].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'paper.pdf')), grouped)
  check('README.txt opens what the console sealed, with the key typed from a paper (in its groups)', byPaper.status === 0 && readFileSync(join(ram, 'paper.pdf')).equals(item))
  const byLower = typing(openWith[0].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'lower.pdf')), grouped.toLowerCase())
  check('and typed in small letters, as the ceremony\'s own check takes it', byLower.status === 0 && readFileSync(join(ram, 'lower.pdf')).equals(item))
  // Later, a YubiKey 5: its lines, one at a time, as README.txt says.
  const later = readme.slice(readme.indexOf('Later, a YubiKey 5')).split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().replace("'^# *Recipient: age1yubikey1'", "'^# *Recipient: age1'")) // the stand-in's key is a software key
  check('README.txt has the lines of a YubiKey added later, and the copy is never made in the iCloud folder', later.length === 5 && readme.includes('NEVER the iCloud'))
  const said = [shell(later[0]), shell(later[1]), typing(later[2], grouped.toLowerCase()), shell(later[3])]
  check(`with them a YubiKey opens the key, to the same recipient (${said.map((run) => run.status).join(' ')})`,
    said[0].status === 0 && said[1].stdout.trim() === 'go on' && said[2].status === 0 && said[3].stdout.trim() === 'the YubiKey opens it')
  const byKey = shell(later[4].replace('/Volumes/OphisRAM/item.pdf', join(ram, 'key.pdf')))
  check('and then opens what the console sealed', byKey.status === 0 && readFileSync(join(ram, 'key.pdf')).equals(item))
  const wrongKey = [typing(later[2], 'NOT THE KEY'), shell(later[3])]
  check('a key typed wrong gives no copy that the check accepts', !wrongKey[1].stdout.includes('opens it'))
  check('when the YubiKey fails to generate, the check line says STOP', shell(later[0], { FAIL: '1' }).status !== 0 && shell(later[1]).stdout.trim() === 'STOP')

  // What stops it, and what it leaves: a stopped run keeps nothing (Clement's laptop, 2026-11-16: a folder left behind
  // by a failed step stopped every run after it).
  const three = (typed) => Array(3).fill(typed)
  const typo1 = ceremony('typo1', { typed: three('NOT THE KEY\n'), mine: true })
  check('paper 1 typed wrong three times stops it, and keeps nothing (an operator\'s own README.txt left as it is)', typo1.status !== 0 && typo1.stdout.includes('paper 1 does not give the key') && nothingKept(typo1))
  const typo2 = ceremony('typo2', { typed: [RIGHT, ...three('NOT THE KEY\n')] })
  check('paper 2 typed wrong three times stops it, and keeps nothing', typo2.status !== 0 && typo2.stdout.includes('paper 2 does not give the key') && nothingKept(typo2))
  const lie = ceremony('lie', { env: { LIE: '1' }, typed: three(RIGHT) })
  check('a key that is not the one announced stops it, and keeps nothing', lie.status !== 0 && lie.stdout.includes('STOPPED') && nothingKept(lie))
  for (const [name, env] of [['IPv4', { ROUTE4: '1' }], ['IPv6 only', { ROUTE6: '1' }]]) {
    const online = ceremony(`online-${name.replace(' ', '')}`, { env })
    check(`it stops while the laptop is online (${name}), before making anything`, online.status !== 0 && online.stdout.includes('is online') && nothingKept(online))
  }
  const kept = ceremony('kept', { mine: true })
  check('a README.txt of the operator\'s own next to the script is left as it is by a run that ends', kept.status === 0 && readFileSync(join(kept.here, 'README.txt'), 'utf8') === 'MINE')
  const readonly = ceremony('readonly-setup')
  for (const f of ['ophis-recipient-g1.txt', 'ophis-seal-g1-README.txt']) rmSync(join(readonly.here, f))
  chmodSync(readonly.here, 0o555)
  const blocked = inPty(answers(), ['/bin/bash', join(readonly.here, 'seal-ceremony.sh')], { HOME: readonly.home, PATH: stubs })
  chmodSync(readonly.here, 0o755)
  check('if the public half cannot be put next to the script, it stops and keeps nothing', blocked.status !== 0 && blocked.stdout.includes('Nothing was kept') && nothingKept(readonly))
  const half = ceremony('half', { env: { CP_FAIL: '1' } })
  check('if the public half fails after the README copy, it takes the README copy back too, and keeps nothing', half.status !== 0 && nothingKept(half))
  const raceHome = join(dir, 'race')
  const race = ceremony('race', { env: { RACE: join(raceHome, 'icloud', 'ophis-recipient-g1.txt') } })
  check('a run that waited while another published its key stops after its claim, and replaces nothing (Codex)', race.status !== 0 && race.stdout.includes('made meanwhile')
    && readFileSync(join(race.here, 'ophis-recipient-g1.txt'), 'utf8') === 'age1pq1other\n' && !existsSync(race.work) && !existsSync(join(race.here, 'ophis-seal-g1-README.txt')))
  // Another run going on: the work folder is claimed at the start; the run stops and leaves it as it was.
  const busy = join(dir, 'busy')
  mkdirSync(join(busy, 'icloud'), { recursive: true })
  mkdirSync(join(busy, '.ophis-seal-g1.run'))
  writeFileSync(join(busy, '.ophis-seal-g1.run', 'other'), 'KEEP')
  writeFileSync(join(busy, 'icloud', 'seal-ceremony.sh'), original)
  const second = inPty(answers(), ['/bin/bash', join(busy, 'icloud', 'seal-ceremony.sh')], { HOME: busy, PATH: stubs })
  check('with another run going on, it stops and leaves that run\'s folder as it was', second.status !== 0 && second.stdout.includes('Another run is going on') && readFileSync(join(busy, '.ophis-seal-g1.run', 'other'), 'utf8') === 'KEEP')
  // A key made before: the public half next to the script stops a second key.
  const third = inPty(answers(), ['/bin/bash', join(good.here, 'seal-ceremony.sh')], { HOME: good.home, PATH: stubs })
  check('run again after a key was made, it stops on the public half and changes nothing', third.status !== 0 && third.stdout.includes('A key was made before')
    && readFileSync(join(good.here, 'ophis-recipient-g1.txt'), 'utf8') === published)
} catch (error) {
  check(`the run (${error.message}${/^spawnSync age(-keygen)? ENOENT/.test(error.message) ? ': brew install age' : ''})`, false)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(failed ? 'FAILED' : 'The age tool opens what the console seals, and the ceremony works with stand-in keys.')
process.exitCode = failed ? 1 : 0
