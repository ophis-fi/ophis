// A local stand-in for the company sign-in of Microsoft and Google (OpenID Connect, authorization code with PKCE),
// on http://127.0.0.1:8792. The local environment's provider constants point here (IDPS in src/server/oidc.ts):
// the Worker holds no stub and no switch. Test only: no real account, no password. The tester types the address to
// sign in as. It shares no code with the Worker: it signs with node:crypto what the Worker verifies with WebCrypto.
//   /microsoft/... and /google/...: GET authorize (the page), POST authorize (the choice), POST token, GET keys
// What it says about an address: a company domain gets a tenant of its own (Microsoft: tenantOf(domain), and
// xms_edov true; Google: hd = the domain, email_verified true). A personal domain (outlook.com, gmail.com, ...) gets
// what the real providers give it: Microsoft's consumer tenant, or no hd claim. The Worker refuses both.
//   node scripts/idp-stub.mjs     serve until stopped ("pnpm dev" and "pnpm test:e2e" start it themselves)
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const PORT = 8792
const BASE = `http://127.0.0.1:${PORT}`
const CALLBACK = 'http://localhost:8787/api/company/callback' // the only address a code is ever sent to
const CONSUMER = '9188040d-6c67-4c5b-b112-36a304b66dad'
const PERSONAL = ['outlook.com', 'hotmail.com', 'live.com', 'gmail.com', 'googlemail.com']
const NAME = { microsoft: 'Microsoft', google: 'Google' }
const sha = (text) => createHash('sha256').update(text)
/** The tenant id this stand-in gives a company domain: stable, so that a seeded organisation can pin it. */
export function tenantOf(domain) {
  const hex = sha(`stub-tenant:${domain}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
const escape = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Starts the stand-in on 127.0.0.1 and returns the function that stops it. The signing key is made at each start. */
export function start() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'stub-1', use: 'sig', alg: 'RS256' }
  const b64 = (value) => Buffer.from(value).toString('base64url')
  const signed = (claims) => {
    const head = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'stub-1' }))}.${b64(JSON.stringify(claims))}`
    return `${head}.${createSign('RSA-SHA256').update(head).sign(privateKey).toString('base64url')}`
  }
  const codes = new Map() // code -> what was asked and who signed in; used once
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, BASE)
    const [, provider, action] = url.pathname.split('/')
    const send = (status, type, body, headers = {}) => response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }).end(body)
    const form = async () => {
      let text = ''
      for await (const chunk of request) text += chunk
      return new URLSearchParams(text)
    }
    if (!Object.hasOwn(NAME, provider)) return send(404, 'text/plain', 'Not found')
    if (request.method === 'GET' && action === 'keys') return send(200, 'application/json', JSON.stringify({ keys: [jwk] }))
    if (request.method === 'GET' && action === 'authorize') {
      const q = url.searchParams
      if (q.get('redirect_uri') !== CALLBACK || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') return send(400, 'text/plain', 'This stand-in serves the local console only.')
      const hidden = ['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'].map((name) => `<input type="hidden" name="${name}" value="${escape(q.get(name))}">`).join('')
      return send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local stand-in for ${NAME[provider]} sign-in</title>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem">
<h1 style="font-size: 1.4rem">Local stand-in for ${NAME[provider]} sign-in</h1>
<p>Test only. This is not ${NAME[provider]}: no real account and no password. Type the work address to sign in as.</p>
<form method="post" action="/${provider}/authorize">${hidden}
<label for="email">Work address</label><br><input id="email" name="email" type="email" required value="${escape(q.get('login_hint'))}" style="font: inherit; width: 100%; padding: .5rem; margin: .25rem 0 1rem">
<button type="submit" style="font: inherit; padding: .5rem 1rem">Sign in as this address</button></form></body></html>`)
    }
    if (request.method === 'POST' && action === 'authorize') {
      const f = await form()
      const email = (f.get('email') ?? '').trim().toLowerCase()
      if (f.get('redirect_uri') !== CALLBACK || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(400, 'text/plain', 'Not a request of the local console, or not an address.')
      const code = randomBytes(24).toString('base64url')
      codes.set(code, { provider, email, clientId: f.get('client_id'), nonce: f.get('nonce'), challenge: f.get('code_challenge') })
      return send(302, 'text/plain', '', { location: `${CALLBACK}?${new URLSearchParams({ code, state: f.get('state') ?? '' })}` })
    }
    if (request.method === 'POST' && action === 'token') {
      const f = await form()
      const asked = codes.get(f.get('code'))
      codes.delete(f.get('code'))
      // The checks of a real token endpoint: the code is its own, once; the client; a secret; the redirect; the PKCE verifier.
      if (!asked || asked.provider !== provider || f.get('grant_type') !== 'authorization_code' || f.get('client_id') !== asked.clientId || !f.get('client_secret')
        || f.get('redirect_uri') !== CALLBACK || sha(f.get('code_verifier') ?? '').digest('base64url') !== asked.challenge) return send(400, 'application/json', JSON.stringify({ error: 'invalid_grant' }))
      const domain = asked.email.split('@')[1]
      const personal = PERSONAL.includes(domain)
      const now = Math.floor(Date.now() / 1000)
      const tid = personal ? CONSUMER : tenantOf(domain)
      const claims = {
        aud: asked.clientId, sub: sha(`${provider}:${asked.email}`).digest('hex').slice(0, 32), email: asked.email, nonce: asked.nonce, iat: now, exp: now + 600,
        ...(provider === 'google' ? { iss: `${BASE}/google`, email_verified: true, ...(!personal && { hd: domain }) } : { iss: `${BASE}/microsoft/${tid}/v2.0`, tid, xms_edov: true }),
      }
      return send(200, 'application/json', JSON.stringify({ token_type: 'Bearer', expires_in: 600, access_token: 'stub', id_token: signed(claims) }))
    }
    return send(404, 'text/plain', 'Not found')
  }).listen(PORT, '127.0.0.1')
  return () => server.close()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  start()
  console.log(`Stand-in for Microsoft and Google sign-in on ${BASE}/microsoft and ${BASE}/google. Test only.`)
}
