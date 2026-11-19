// The operator's review page (owner, 2026-11-19): what "operator list" prints, and the decisions of "operator decide",
// in a browser on the operator's host. It holds no token: Cloudflare Access signs the operator in, and the Worker checks
// that the email Access signed is the operator's (onboarding.ts, operate). Every value is set as text, never as markup.
// The list files of a screening are hashed here; only their SHA-256 leaves the computer, as with the command.
import '../src/app/fonts.css' // Inter, copied by this build into /operator/assets/: the page's policy has font-src 'self'
import '../src/app/kit.css'
import '../src/app/app.css'
import './operator.css'

interface Person { name: string; position?: string | null; email?: string | null; phone?: string | null; telegram?: string | null; role?: string }
interface Application {
  id: string; legalName: string; kind: string; businessType: string | null; country: string; registration: string | null; lei: string | null; address: string | null; domain: string
  submittedAt: number; submission: string; applicant: Person; credentialHash: string; people: Person[]; missing: string | null; refused: string[]
  declaration: { size: number; at: number; sha256: string } | null
  wallet: { address: string; chain: string; kind: string; threshold?: number; owners?: number; colour: { level: string; why?: string } } | null
}
interface Review { id: string; name: string; state: string; outcome: string | null; screenedAt: number | null; nextReview: number | null; lastAction?: string | null; lastDetail?: string | null }
interface List { list: string; entries: number; published: string | null; loadedAt: number | null; stale?: boolean; held?: string | null }

const $ = (id: string) => document.getElementById(id)!
const day = (time: number | null | undefined) => (time ? new Date(time).toISOString().slice(0, 10) : 'none')
const person = (p: Person) => [p.name, p.position, p.email, p.phone, p.telegram].filter(Boolean).join(', ')
const EVIDENCE = /^[\w ./:#-]{1,120}$/ // the server's rule (onboarding.ts, decide)
const WORDS: Record<string, string> = {
  operator_identity: 'This Cloudflare sign-in is not the operator\'s email. Sign in with the operator\'s account.',
  access_required: 'The Cloudflare sign-in is missing or has expired. Reload the page.',
  not_ready: 'The application is not complete yet: it cannot be approved.',
  submission_changed: 'The application changed since this page read it. The list was read again: check it, then decide.',
  wallet_listed: 'The recovery wallet is on a loaded sanctions list: it cannot be approved.',
  wallet_unreadable: 'The recovery wallet could not be read on the chain just now. Try again in a minute.',
  try_again: 'The recovery wallet changed meanwhile. The list was read again: check it, then decide.',
  not_under_review: 'This organisation is no longer under review.',
  screening_not_clear: 'An approval needs a screening that found no match.',
  invalid: 'A value was refused: check the evidence reference, the SHA-256 and the date of the next review.',
}

function say(text: string, tone: 'ok' | 'bad' | '' = '') {
  const status = $('status')
  status.textContent = text
  status.className = `note ${tone}`
  status.hidden = false
}

/** One call of the operator's API: same origin, no token. A failed network or an expired sign-in (a redirect to Access) throws. */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { ok: response.ok, data: await response.json().catch(() => ({})) }
}
const failed = (error?: string) => WORDS[error ?? ''] ?? `Refused (${error ?? 'no answer'}). Nothing was changed.`

async function hashOf(file: File) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function card(o: Application) {
  const node = ($('application') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment
  const f = (name: string) => node.querySelector(`[data-f="${name}"]`) as HTMLElement
  const kind = [o.businessType, o.kind, o.country, o.registration, o.lei && `LEI ${o.lei}`].filter(Boolean).join(', ')
  f('title').textContent = `${o.legalName} (${kind})`
  f('id').textContent = o.id
  f('address').textContent = o.address ?? 'none given'
  f('domain').textContent = o.domain
  f('submitted').textContent = `${new Date(o.submittedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  f('owner').textContent = person(o.applicant)
  f('passkey').textContent = o.credentialHash
  f('people').textContent = o.people.length ? o.people.map((p) => `${person(p)}, ${p.role}`).join('; ') : 'None besides the first Owner'
  const w = o.wallet
  f('wallet').textContent = w ? `${w.address} on ${w.chain}, ${w.kind}${w.threshold ? ` ${w.threshold} of ${w.owners}` : ''}, ${w.colour.level}${w.colour.why ? ` (${w.colour.why})` : ''}` : 'None named yet'
  f('declaration').textContent = o.declaration ? `${o.declaration.size} bytes, uploaded ${day(o.declaration.at)}, SHA-256 ${o.declaration.sha256}` : 'None uploaded'
  f('ready').textContent = o.missing ? `No: ${o.missing}` : 'Yes'
  if (o.refused.length) {
    f('refused').textContent = `A wallet this application named was refused: it is on a loaded sanctions list (${o.refused.join(', ')}).`
    f('refused').hidden = false
  }
  const approve = f('approve') as HTMLFormElement, other = f('other') as HTMLFormElement
  const source = f('source') as HTMLSelectElement, tier = f('tier') as HTMLSelectElement
  const field = (name: string) => approve.elements.namedItem(name) as HTMLInputElement
  const today = new Date().toISOString().slice(0, 10)
  field('evidence').value = `${o.registration ?? ''} checked ${today}`.replace(/[^\w ./:#-]/g, '').trim()
  field('sha256').value = o.declaration?.sha256 ?? ''
  const next = new Date()
  next.setUTCFullYear(next.getUTCFullYear() + 1)
  field('next').value = next.toISOString().slice(0, 10)
  if (o.missing) for (const control of approve.elements) (control as HTMLButtonElement).disabled = true

  approve.addEventListener('submit', (event) => {
    event.preventDefault()
    void act(async () => {
      const evidence = field('evidence').value.trim(), sha256 = field('sha256').value.trim().toLowerCase()
      if (!EVIDENCE.test(evidence)) return say('The evidence reference takes letters, digits, spaces and . / : # - only, 120 at most.', 'bad')
      if (!/^[0-9a-f]{64}$/.test(sha256)) return say('The SHA-256 is 64 characters: digits and the letters a to f.', 'bad')
      const lists: Record<string, string> = {}
      for (const code of ['eu', 'un', 'ofac']) {
        const file = field(code).files?.[0]
        if (file) lists[code] = await hashOf(file)
      }
      if (!lists.eu) return say('Choose the EU list file: the EU list is in every screening.', 'bad')
      if (!confirm(`Approve ${o.legalName}? The organisation becomes active, with the people its application named.`)) return
      const done = await call<{ state: string }>('POST', `/api/operator/organisations/${o.id}/decision`, {
        decision: 'approve', tier: tier.value, source: source.value, evidenceRef: evidence, evidenceSha256: sha256, nextReview: field('next').value,
        submission: o.submission, screening: { outcome: 'clear', lists },
      })
      await load()
      say(done.ok ? `Approved: ${o.legalName} is now ${done.data.state}.` : failed(done.data.error), done.ok ? 'ok' : 'bad')
    })
  })
  other.addEventListener('submit', (event) => {
    event.preventDefault()
    const decision = ((event as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'refuse' ? 'refuse' : 'more'
    const reason = (other.elements.namedItem('reason') as HTMLSelectElement).value
    void act(async () => {
      if (!confirm(decision === 'refuse' ? `Refuse ${o.legalName}? The organisation is closed.` : `Send ${o.legalName} back for more information? The applicant reads the reason.`)) return
      const done = await call<{ state: string }>('POST', `/api/operator/organisations/${o.id}/decision`, { decision, reason, tier: tier.value, source: source.value })
      await load()
      say(done.ok ? `${decision === 'refuse' ? 'Refused' : 'Sent back for more information'}: ${o.legalName}.` : failed(done.data.error), done.ok ? 'ok' : 'bad')
    })
  })
  return node
}

function line(text: string, tone?: string) {
  const li = document.createElement('li')
  li.textContent = text
  if (tone) li.className = `note ${tone}`
  return li
}

async function load() {
  const read = await call<{ organisations: Application[]; more: number; reviews: Review[]; lists: List[] }>('GET', '/api/operator/organisations')
  if (!read.ok) return say(failed(read.data.error), 'bad')
  const { organisations, more, reviews, lists } = read.data
  const apps = $('apps')
  apps.replaceChildren(...organisations.map(card))
  if (!organisations.length) apps.replaceChildren(line('Nothing is under review.'))
  if (more) apps.append(line(`${more} more under review: decide these first, then reload.`, 'warn'))
  $('reviews').replaceChildren(...(reviews.length ? reviews.map((r) => line(`${r.name} (${r.id}): ${r.state}, last screening ${r.outcome ? `${r.outcome} on ${day(r.screenedAt)}` : 'none'}, next review ${day(r.nextReview)}${r.lastAction ? `, frozen by ${r.lastAction}${r.lastDetail ? ` (${r.lastDetail})` : ''}` : ''}`)) : [line('No review is due, and no organisation is frozen.')]))
  $('lists').replaceChildren(...lists.map((l) => line(`${l.list.toUpperCase()}: ${l.entries} addresses, published ${l.published ?? 'not known'}, loaded ${day(l.loadedAt)}${l.stale ? '. Out of date: the desk sends no order. Load the list again with the command.' : ''}${l.held ? `. A newer list file was held (${l.held}).` : ''}`, l.stale || l.held ? 'warn' : undefined)))
}

/** Runs one action with every button off, and says plainly when the network or the sign-in failed. */
async function act(run: () => Promise<unknown>) {
  const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled) // an application that is not ready keeps its own off
  for (const button of buttons) button.disabled = true
  try {
    await run()
  } catch {
    say('The network failed, or the Cloudflare sign-in has expired. Reload the page.', 'bad')
  } finally {
    for (const button of buttons) button.disabled = false
  }
}

$('invite').addEventListener('click', () => void act(async () => {
  const made = await call<{ code: string; expiresAt: number }>('POST', '/api/operator/invites', {})
  if (!made.ok) return say(failed(made.data.error), 'bad')
  $('code').textContent = `${made.data.code}, valid until ${new Date(made.data.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, one use. The client applies at https://pro.ophis.fi/apply`
  $('code').hidden = false
}))

void act(load)
