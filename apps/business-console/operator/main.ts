// The operator's review page (owner, 2026-11-19): what "operator list" prints, and the decisions of "operator decide",
// in a browser on the operator's host. It holds no token: Cloudflare Access signs the operator in, and the Worker checks
// that the email Access signed is the operator's (onboarding.ts, operate). Every value is set as text, never as markup.
import type { NameReport } from '../src/shared/sanctions-names.ts'
import '../src/app/kit.css'
import '../src/app/app.css'
import './operator.css'

interface Person { name: string; position?: string | null; email?: string | null; phone?: string | null; telegram?: string | null; role?: string }
interface Application {
  id: string; legalName: string; kind: string; businessType: string | null; country: string; registration: string | null; lei: string | null; address: string | null; domain: string
  submittedAt: number; submission: string; applicant: Person; credentialHash: string; people: Person[]; missing: string | null; refused: string[]
  declaration: { size: number; at: number; sha256: string } | null
  wallet: { address: string; chain: string; kind: string; recoveryEligible: boolean; threshold?: number; owners?: number; colour: { level: string; why?: string } } | null
}
interface Draft {
  id: string; legalName: string; kind: string; country: string | null; registration: string | null; domain: string | null
  submittedAt: null; missing: string | null
}
interface Review { id: string; name: string; state: string; outcome: string | null; screenedAt: number | null; nextReview: number | null; lastAction?: string | null; lastDetail?: string | null }
interface List { list: string; entries: number; published: string | null; loadedAt: number | null; stale?: boolean; held?: string | null }
interface Organisation { registrationCheck: string | null; id: string; name: string; kind: string; country: string | null; state: string; members: number; nextReview: number | null }

const $ = (id: string) => document.getElementById(id)!
const day = (time: number | null | undefined) => (time ? new Date(time).toISOString().slice(0, 10) : 'none')
const person = (p: Person) => [p.name, p.position, p.email, p.phone, p.telegram].filter(Boolean).join(', ')
const EVIDENCE = /^[\w ./:#-]{1,120}$/ // the server's rule (onboarding.ts, decide)
const WORDS: Record<string, string> = {
  operator_identity: 'This Cloudflare sign-in is not the operator\'s email. Sign in with the operator\'s account.',
  access_required: 'The Cloudflare sign-in is missing or has expired. Reload the page.',
  not_ready: 'The application is not complete yet: it cannot be approved.',
  submission_changed: 'The application changed since this page read it. The list was read again: check it, then decide.',
  wallet_listed: 'An organisation wallet is on a loaded sanctions list. This blocks approval and unfreezing.',
  wallet_unreadable: 'The recovery wallet could not be read on the chain just now. Try again in a minute.',
  try_again: 'The recovery wallet changed meanwhile. The list was read again: check it, then decide.',
  not_under_review: 'This organisation is no longer under review.',
  wrong_state: 'The organisation has changed state. Check its current status before trying again.',
  screening_changed: 'The names or sanctions lists changed. Review the refreshed results before approving.',
  screening_incomplete: 'Screening is incomplete. Check the names again before approving.',
  screening_not_clear: 'The screening result blocks this action. Record a clear screening to proceed.',
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
  return { ok: response.ok, data: await response.json() }
}
const failed = (error?: string) => WORDS[error ?? ''] ?? `Refused (${error ?? 'no answer'}). Nothing was changed.`
const NETWORK = 'The network failed, or the Cloudflare sign-in has expired. Reload the page.'

const SOURCES: Record<string, [string, string]> = {
  eu: ['EU', 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions'],
  un: ['UN', 'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list'],
  ofac: ['OFAC SDN', 'https://ofac.treasury.gov/sanctions-list-service'],
}

function nameCheck(node: DocumentFragment, id: string, changed: (result: NameReport | null) => void) {
  const section = ($('name-check') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment
  const signer = section.querySelector<HTMLInputElement>('[data-signer]')!
  const status = section.querySelector<HTMLElement>('[data-result]')!
  const coverage = section.querySelector<HTMLElement>('[data-coverage]')!
  const matches = section.querySelector<HTMLElement>('[data-matches]')!
  let sequence = 0
  const invalidate = () => {
    sequence++
    changed(null)
    matches.replaceChildren()
    coverage.textContent = ''
    status.textContent = 'Run the check for the name entered.'
  }
  async function refresh() {
    invalidate()
    const request = sequence
    status.textContent = 'Checking registered names…'
    const response = await call<NameReport>('POST', `/api/operator/organisations/${id}/name-screening`, signer.value.trim() ? { signatory: signer.value.trim() } : {}).catch(() => null)
    if (request !== sequence) return
    if (!response?.ok) { status.textContent = 'Check incomplete. Check the name and try again.'; return }
    const result = response.data
    signer.value = result.signatory ?? ''
    status.textContent = result.status === 'incomplete' ? `Check incomplete. ${result.problem}` : result.matches.length ? 'Possible match — review the entries below.' : 'No matching name found.'
    coverage.textContent = `Names: ${result.names.join(', ')}. ${result.lists ? `EU, UN and OFAC SDN lists downloaded ${day(result.updatedAt)}.` : 'Lists unavailable.'}`
    for (const match of result.matches) for (const [code, reference, alias] of match.entries) {
      const item = line(`${match.subject} — ${alias} · `)
      const link = document.createElement('a')
      link.href = SOURCES[code][1]
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = `${SOURCES[code][0]} ${reference}`
      item.append(link)
      matches.append(item)
    }
    changed(result)
  }
  signer.addEventListener('input', invalidate)
  section.querySelector('button')!.addEventListener('click', () => void refresh())
  node.querySelector('[data-name-check]')!.append(section)
  void refresh()
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
  f('wallet').textContent = w ? `${w.address} on ${w.chain}, ${w.kind}${w.threshold ? ` ${w.threshold} of ${w.owners}` : ''}, ${w.colour.level}${w.colour.why ? ` (${w.colour.why})` : ''}. ${w.recoveryEligible ? 'Becomes the recovery wallet on approval.' : 'Activation verified only. Approval leaves wallet recovery unconfigured.'}` : 'None named yet'
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

  let result: NameReport | null = null
  const resolution = field('resolution')
  const button = approve.querySelector('button')!
  function ready() {
    button.disabled = !!o.missing || !result || result.status === 'incomplete' || (!!result.matches.length && !resolution.value.trim())
  }
  resolution.addEventListener('input', ready)
  nameCheck(node, o.id, (next) => {
    result = next
    resolution.value = ''
    resolution.required = !!next?.matches.length
    approve.querySelector<HTMLElement>('[data-resolution]')!.hidden = !resolution.required
    ready()
  })

  approve.addEventListener('submit', (event) => {
    event.preventDefault()
    void act(async () => {
      const evidence = field('evidence').value.trim(), sha256 = field('sha256').value.trim().toLowerCase()
      if (!EVIDENCE.test(evidence)) return say('The evidence reference takes letters, digits, spaces and . / : # - only, 120 at most.', 'bad')
      if (!/^[0-9a-f]{64}$/.test(sha256)) return say('The SHA-256 is 64 characters: digits and the letters a to f.', 'bad')
      if (!result || result.status === 'incomplete' || (result.matches.length && !resolution.value.trim())) return
      if (!confirm(`Approve ${o.legalName}? The organisation becomes active, with the people its application named.`)) return
      const done = await call<{ state: string }>('POST', `/api/operator/organisations/${o.id}/decision`, {
        decision: 'approve', tier: tier.value, source: source.value, evidenceRef: evidence, evidenceSha256: sha256, nextReview: field('next').value,
        submission: o.submission, revision: result.revision, signatory: result.signatory, resolution: resolution.value.trim() || undefined,
      })
      await settle(done, `Approved: ${o.legalName} is now ${done.data.state}.`)
    })
  })
  other.addEventListener('submit', (event) => {
    event.preventDefault()
    const decision = ((event as SubmitEvent).submitter as HTMLButtonElement | null)?.value === 'refuse' ? 'refuse' : 'more'
    const reason = (other.elements.namedItem('reason') as HTMLSelectElement).value
    void act(async () => {
      if (!confirm(decision === 'refuse' ? `Refuse ${o.legalName}? The organisation is closed.` : `Send ${o.legalName} back for more information? The applicant reads the reason.`)) return
      const done = await call<{ state: string }>('POST', `/api/operator/organisations/${o.id}/decision`, { decision, reason, tier: tier.value, source: source.value })
      await settle(done, `${decision === 'refuse' ? 'Refused' : 'Sent back for more information'}: ${o.legalName}.`)
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

function organisationRow(o: Organisation) {
  const row = line(`${o.name} (${[o.kind, o.country].filter(Boolean).join(', ')}): ${o.state}, ${o.members} active ${o.members === 1 ? 'member' : 'members'}, next review ${day(o.nextReview)}. ${o.id}`)
  if (o.state === 'applying' || o.state === 'under review') {
    if (o.registrationCheck === 'possible match') row.append(' · Possible sanctions match at registration. ')
    else if (o.registrationCheck === 'incomplete') row.append(' · Registration screening incomplete. ')
    const link = document.createElement('a')
    link.href = `/operator/applications/${o.id}`
    link.textContent = o.state === 'applying' ? 'View application progress' : 'Review application'
    row.append(' ', link)
  } else if (o.state === 'active' || o.state === 'frozen') {
    const freezing = o.state === 'active'
    const action = freezing ? 'Freeze' : 'Unfreeze'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn ghost sm'
    button.textContent = action
    button.setAttribute('aria-label', `${action} ${o.name}`)
    button.addEventListener('click', () => void act(async () => {
      if (!confirm(`${action} ${o.name}? ${freezing ? 'All member sessions will end.' : 'Members will be able to sign in again.'}`)) return
      const done = await call<{ state: string }>('POST', `/api/operator/organisations/${o.id}/${freezing ? 'freeze' : 'unfreeze'}`, {})
      await settle(done, `${o.name} is now ${done.data.state}.`)
    }))
    row.append(' ', button)
  }
  return row
}

function draftCard(o: Draft) {
  const node = ($('draft') as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment
  nameCheck(node, o.id, () => {})
  node.querySelector('h2')!.textContent = `${o.legalName} · Awaiting submission`
  node.querySelector('[data-summary]')!.textContent = [o.kind, o.country, o.registration, o.domain, o.id].filter(Boolean).join(' · ')
  const steps: Record<string, string> = {
    owner_key: 'The first Owner needs an active passkey that meets the organisation’s key policy.',
    proof_or_owner: 'The organisation needs a verified activation wallet or a second active Owner with a qualifying passkey.',
    declaration: 'The Owner needs to upload the signed declaration.',
  }
  const next = o.missing ? steps[o.missing] ?? 'The applicant must complete onboarding.' : 'The application is ready to submit.'
  node.querySelector('[data-next]')!.textContent = `${next} An Owner must select “Submit for review” in Onboarding before you can make a decision.`
  return node
}

// After a decision the list is read again, so that no card shows what changed; but not after a refusal the operator can
// retry as it is (CodeRabbit, PR #1670): the form keeps the files and values entered.
const KEEP = ['wallet_unreadable', 'invalid', 'screening_not_clear', 'screening_required']
async function settle(done: { ok: boolean; data: { error?: string } }, success: string) {
  if (done.ok && location.pathname.startsWith('/operator/applications/')) history.replaceState(null, '', '/')
  const problem = done.ok || !KEEP.includes(done.data.error ?? '') ? await load() : ''
  say([done.ok ? success : failed(done.data.error), problem].filter(Boolean).join(' '), done.ok && !problem ? 'ok' : 'bad')
}

/** Reads the list and shows it; answers what went wrong, or ''. A failed read, refused or never answered, takes the cards
 *  away: none is decided on stale data (CodeRabbit, PR #1670: a refresh that threw left the old cards live). */
async function load(): Promise<string> {
  const id = /^\/operator\/applications\/([0-9a-f]{32})$/.exec(location.pathname)?.[1]
  for (const section of document.querySelectorAll<HTMLElement>('[data-directory]')) section.hidden = !!id
  $('detail-heading').hidden = !id
  const apps = $('apps')
  if (id) {
    apps.replaceChildren()
    const read = await call<Application | Draft>('GET', `/api/operator/organisations/${id}/application`).catch(() => null)
    if (!read) return NETWORK
    if (!read.ok) return read.data.error === 'not_found' ? 'This application is no longer open or could not be found.' : failed(read.data.error)
    apps.append(read.data.submittedAt === null ? draftCard(read.data) : card(read.data))
    return ''
  }
  const read = await call<{ organisations: Application[]; more: number; reviews: Review[]; lists: List[]; all: Organisation[] }>('GET', '/api/operator/organisations').catch(() => null)
  if (!read?.ok) {
    $('all').replaceChildren()
    $('reviews').replaceChildren()
    $('lists').replaceChildren()
    apps.replaceChildren(line('The list could not be read: reload the page.', 'warn'))
    return read ? failed(read.data.error) : NETWORK
  }
  const { organisations, more, reviews, lists, all } = read.data
  // Every organisation, the approved ones too (owner, 2026-11-19).
  $('all').replaceChildren(...(all.length ? all.map(organisationRow) : [line('No organisation yet.')]))
  apps.replaceChildren(...organisations.map(card))
  if (!organisations.length) apps.replaceChildren(line('Nothing is under review.'))
  if (more) apps.append(line(`${more} more under review. Open them from All organisations.`, 'warn'))
  $('reviews').replaceChildren(...(reviews.length ? reviews.map((r) => line(`${r.name} (${r.id}): ${r.state}, last screening ${r.outcome ? `${r.outcome} on ${day(r.screenedAt)}` : 'none'}, next review ${day(r.nextReview)}${r.lastAction ? `, frozen by ${r.lastAction}${r.lastDetail ? ` (${r.lastDetail})` : ''}` : ''}`)) : [line('No review is due, and no organisation is frozen.')]))
  $('lists').replaceChildren(...lists.map((l) => line(`${l.list.toUpperCase()}: ${l.entries} addresses, published ${l.published ?? 'not known'}, loaded ${day(l.loadedAt)}${l.stale ? '. Out of date: the desk sends no order. Load the list again with the command.' : ''}${l.held ? `. A newer list file was held (${l.held}).` : ''}`, l.stale || l.held ? 'warn' : undefined)))
  return ''
}

/** Runs one action with every button off, and says plainly when the network or the sign-in failed. */
async function act(run: () => Promise<unknown>) {
  const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled) // an application that is not ready keeps its own off
  for (const button of buttons) button.disabled = true
  try {
    await run()
  } catch {
    say(NETWORK, 'bad')
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

void act(async () => {
  const problem = await load()
  if (problem) say(problem, 'bad')
})
