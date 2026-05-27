/**
 * POST /api/contact
 *
 * Relays the website contact form to the Ophis inbox via Brevo's
 * transactional email API. Browser → this function → Brevo. The
 * recipient address and Brevo key are Cloudflare Pages env values and
 * never reach the browser or the (public) repo source.
 *
 * Env (set on the Pages project):
 *   - BREVO_API_KEY   (secret)  Brevo transactional-email API key.
 *   - CONTACT_INBOX   (var)     Destination + verified Brevo sender, e.g.
 *                               the address you monitor. Used as both
 *                               From and To; the visitor's address goes in
 *                               replyTo so you can reply directly.
 *   - OPHIS_RATELIMIT (KV, opt) Shared rate-limit namespace (same binding
 *                               the intent API uses).
 */

interface Env {
  BREVO_API_KEY: string
  CONTACT_INBOX: string
  OPHIS_RATELIMIT?: KVNamespace
}

type ErrorCode = 'BAD_INPUT' | 'RATE_LIMITED' | 'FORBIDDEN' | 'UPSTREAM' | 'NOT_CONFIGURED'

type ContactResponse = { ok: true } | { ok: false; error: { code: ErrorCode; message: string } }

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'
const MAX_NAME = 120
const MAX_EMAIL = 254
const MAX_MESSAGE = 4000

// Contact is low-volume + abuse-prone; cap tighter than the intent API.
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 5
const RATE_LIMIT_MAX_KEYS = 2048

// Per-isolate fallback bucket, used when the KV binding is absent or errors.
// Best-effort (each isolate has its own Map) but bounds the Brevo relay
// instead of failing open in exactly the misconfig case rate-limiting guards.
const ipBuckets = new Map<string, number[]>()

function checkRateLimitIsolate(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  if (ipBuckets.size > RATE_LIMIT_MAX_KEYS) {
    for (const k of Array.from(ipBuckets.keys()).slice(0, 256)) ipBuckets.delete(k)
  }
  const recent = (ipBuckets.get(ip) ?? []).filter((t) => t >= cutoff)
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
    ipBuckets.set(ip, recent)
    return { ok: false, retryAfterSec }
  }
  recent.push(now)
  ipBuckets.set(ip, recent)
  return { ok: true }
}

const ALLOWED_ORIGINS = new Set<string>(['https://ophis.fi', 'https://greg-etm.pages.dev'])
const ALLOWED_ORIGIN_SUFFIXES = ['.greg-etm.pages.dev', '.greg.pages.dev']

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false
  if (ALLOWED_ORIGINS.has(origin)) return true
  try {
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => new URL(origin).host.endsWith(suffix))
  } catch {
    return false
  }
}

const json = (body: ContactResponse, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })

async function checkRateLimit(env: Env, ip: string): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
  const kv = env.OPHIS_RATELIMIT
  if (!kv) return checkRateLimitIsolate(ip)
  const now = Date.now()
  const cutoff = now - RATE_LIMIT_WINDOW_MS
  const key = `contact-rl:${ip}`
  try {
    const raw = await kv.get(key)
    let timestamps: number[] = []
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) timestamps = parsed.filter((t): t is number => typeof t === 'number' && t >= cutoff)
    }
    if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterSec = Math.max(1, Math.ceil((timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000))
      return { ok: false, retryAfterSec }
    }
    timestamps.push(now)
    await kv.put(key, JSON.stringify(timestamps), { expirationTtl: 120 })
    return { ok: true }
  } catch {
    // KV outage → fall back to the per-isolate cap rather than failing open.
    return checkRateLimitIsolate(ip)
  }
}

// Conservative email shape check. Not RFC-complete — just enough to
// reject obvious junk before handing the address to Brevo as replyTo.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  // Contact is a browser-form-only endpoint (no public API use case), so
  // require an allowed Origin. Browsers always send Origin on POST, so this
  // rejects curl/script abuse without blocking the legitimate form.
  const origin = request.headers.get('origin')
  if (!isAllowedOrigin(origin)) {
    return json({ ok: false, error: { code: 'FORBIDDEN', message: 'origin not allowed' } }, 403)
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
  const rl = await checkRateLimit(env, ip)
  if (!rl.ok) {
    return json({ ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } }, 429, {
      'retry-after': String(rl.retryAfterSec),
    })
  }

  if (!env.BREVO_API_KEY || !env.CONTACT_INBOX) {
    return json({ ok: false, error: { code: 'NOT_CONFIGURED', message: 'contact form is not configured' } }, 500)
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'invalid JSON body' } }, 400)
  }

  // Honeypot: bots fill hidden fields humans never see. If `company`
  // has any value, silently accept (return ok) so the bot gets no
  // signal, but send nothing.
  if (asString(body.company)) {
    return json({ ok: true })
  }

  const name = asString(body.name)
  const email = asString(body.email)
  const message = asString(body.message)

  if (!name || name.length > MAX_NAME) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'name required' } }, 400)
  }
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'valid email required' } }, 400)
  }
  if (!message || message.length > MAX_MESSAGE) {
    return json({ ok: false, error: { code: 'BAD_INPUT', message: 'message required' } }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: env.CONTACT_INBOX, name: 'Ophis contact form' },
        to: [{ email: env.CONTACT_INBOX }],
        replyTo: { email, name },
        subject: `Ophis contact: ${name}`,
        textContent: `${name} <${email}> wrote via ophis.fi/contact:\n\n${message}`,
      }),
    })
  } catch {
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'failed to send message' } }, 502)
  }

  if (!upstream.ok) {
    return json({ ok: false, error: { code: 'UPSTREAM', message: 'failed to send message' } }, 502)
  }

  return json({ ok: true })
}

// Reject non-POST methods.
export const onRequest: PagesFunction<Env> = ({ request }) =>
  json({ ok: false, error: { code: 'BAD_INPUT', message: `method ${request.method} not allowed` } }, 405)
