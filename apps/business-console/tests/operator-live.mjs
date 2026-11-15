// The operator's command with --production, heard on this machine: tests/e2e.mjs runs it, and so can a check of one
// change, from the app folder: node tests/operator-live.mjs <a folder it may empty>. node:https points at a local
// listener (tests/fixtures/https-local.mjs, which takes only the operator's address), and "security", "cloudflared"
// and "wrangler" are stand-ins on the PATH that log every call and answer only the exact call the command must make.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const OLD = 'k'.repeat(64), ACCESS = 'aaa.bbb.ccc'
const KEYCHAIN = 'find-generic-password -a operator -s ophis-operator-token -w'

export async function hear(dir) {
  rmSync(dir, { recursive: true, force: true })
  const bin = `${dir}/bin`, calls = `${dir}/calls`, kept = `${dir}/kept`, put = `${dir}/put`
  mkdirSync(bin, { recursive: true })
  const tool = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`, { mode: 0o755 })
  // "security -i" reads one command on stdin and, as the real one does when a command fails, repeats it on both
  // outputs. find gives the token "-i" kept, else the old one. Kept is false: a Keychain that keeps nothing.
  const security = (keeps) => tool('security', `case "$1" in
  -i) line=$(cat); echo "$line"; echo "$line" >&2; ${keeps ? `printf %s "$line" > ${kept}` : ':'} ;;
  find-generic-password) [ "$*" = "${KEYCHAIN}" ] || exit 1; if [ -f ${kept} ]; then sed 's/.* -w //' ${kept}; else echo ${OLD}; fi ;;
  *) exit 1 ;;
esac`)
  // With no token, the stand-in still prints a line on stdout and exits 1: the command must go by the exit code.
  const cloudflared = (token) => tool('cloudflared', `[ "$*" = "access token -app=https://operator.ophis.fi" ] && { ${token ? `echo ${ACCESS}` : 'echo not.a.token; exit 1'}; }\nexit 0`)
  tool('wrangler', `[ "$*" = "secret put OPERATOR_TOKEN --env production" ] || exit 1\ncat > ${put}`)
  const heard = []
  let edge = false // true: answer as Access does when it refuses at the edge, with a page and no JSON
  const server = createServer((request, response) => {
    if (edge) return response.writeHead(403, { 'content-type': 'text/html' }).end('<html>Forbidden</html>')
    heard.push({ method: request.method, url: request.url, host: request.headers.host, origin: request.headers.origin, site: request.headers['sec-fetch-site'], authorization: request.headers.authorization, access: request.headers['cf-access-token'] })
    response.writeHead(200, { 'content-type': 'application/json' }).end(request.method === 'POST' ? '{"code":"c0de","expiresAt":0}' : '{"organisations":[],"more":0,"reviews":[],"lists":[]}')
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, E2E_PORT: String(server.address().port) }
  delete env.OPERATOR_TOKEN // the command reads these two first: not here
  delete env.CF_ACCESS_TOKEN
  let said = ''
  const go = (args) => new Promise((resolve) => {
    const child = spawn('node', ['--import', './tests/fixtures/https-local.mjs', 'scripts/operator.mjs', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => (said += chunk))
    child.stderr.on('data', (chunk) => (said += chunk))
    child.on('close', resolve)
  })
  const run = (...args) => go([...args, '--production'])
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
  const log = () => {
    const text = read(calls) ?? ''
    rmSync(calls, { force: true })
    return text
  }
  security(true)
  cloudflared(true)
  const codes = [await run('list'), await run('invite')]
  log()
  cloudflared(false)
  codes.push(await run('list'))
  const noAccess = log(), sent = heard.length
  codes.push(await run('token'))
  const token = { calls: log(), kept: read(kept), put: read(put) }
  rmSync(kept, { force: true })
  rmSync(put, { force: true })
  security(false)
  codes.push(await run('token'))
  const unkept = { calls: log(), put: read(put) }
  codes.push(await go(['token'])) // without --production: refused, nothing called
  const plain = { calls: log(), put: read(put) }
  security(true)
  cloudflared(true)
  edge = true
  const shown = said // what the runs above printed
  said = ''
  codes.push(await run('list'))
  const refused = said
  server.close()
  return { codes, heard, sent, noAccess, token, unkept, plain, shown, refused }
}

/** What must hold, as [what, ok] pairs. */
export function verdict({ codes, heard, sent, noAccess, token, unkept, plain, shown, refused }) {
  const asked = (method, url, origin) => ({ method, url, host: 'operator.ophis.fi', origin, site: 'same-origin', authorization: `Bearer ${OLD}`, access: ACCESS })
  const fresh = token.put ?? ''
  return [
    ['--production: "list" and "invite" go to operator.ophis.fi:443 with the Keychain token and the Access token (a POST from the origin https://operator.ophis.fi)',
      codes[0] === 0 && codes[1] === 0 && JSON.stringify(heard.slice(0, 2)) === JSON.stringify([asked('GET', '/api/operator/organisations'), asked('POST', '/api/operator/invites', 'https://operator.ophis.fi')])],
    ['--production with no Access token: cloudflared is asked to sign in, quietly, then the command stops and sends nothing',
      codes[2] === 1 && sent === 2 && heard.length === 2 && noAccess === `security ${KEYCHAIN}\ncloudflared access token -app=https://operator.ophis.fi\ncloudflared access login --quiet --auto-close https://operator.ophis.fi\ncloudflared access token -app=https://operator.ophis.fi\n`],
    ['"token --production": a new token of 64 hex goes to the Keychain and to the Worker secret on stdin only: in no argument, never shown',
      codes[3] === 0 && /^[0-9a-f]{64}$/.test(fresh) && fresh !== OLD && token.kept === `add-generic-password -U -a operator -s ophis-operator-token -w ${fresh}`
        && token.calls === `security -i\nsecurity ${KEYCHAIN}\nwrangler secret put OPERATOR_TOKEN --env production\n` && !shown.includes(fresh)],
    ['"token --production" with a Keychain that does not keep it: refused, and nothing goes to Cloudflare',
      codes[4] === 1 && unkept.put === null && unkept.calls === `security -i\nsecurity ${KEYCHAIN}\n`],
    ['"token" without --production: refused, nothing called',
      codes[5] === 1 && plain.calls === '' && plain.put === null],
    ['--production refused by Access at the edge: the command says to sign in again with "--quiet", which does not print the token',
      codes[6] === 1 && refused.includes('Refused (403)') && refused.includes('run "cloudflared access login --quiet https://operator.ophis.fi"')],
  ]
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const results = verdict(await hear(process.argv[2]))
  for (const [what, ok] of results) console.log(`${ok ? 'ok    ' : 'FAILED'} ${what}`)
  process.exit(results.every(([, ok]) => ok) ? 0 : 1)
}
