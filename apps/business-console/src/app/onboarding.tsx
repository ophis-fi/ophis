// Milestone 5a: the public application page (/apply), the Onboarding page, the KYB record block of the Compliance
// page, and the plain page of an organisation that is frozen or closed. Every value shown comes from the server.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { kindOf } from './pages.tsx'
import { api, CANCELLED, Icon, minute, say, Section, sensitive, stamp, Status, Tile } from './ui.tsx'

const Problem = ({ children }: { children: string }) => <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{children}</span></p>
const day = (time: number) => new Date(time).toISOString().slice(0, 10)

// What the server's refusals mean here, in the reader's words. Anything else falls back to the console's own list.
const SAY: Record<string, string> = {
  legal_name_invalid: 'Enter the legal name of the company, 2 to 120 characters.',
  country_invalid: 'Enter the country as its two-letter code, for example LU.',
  registration_invalid: 'Enter the registration number or the LEI: letters and digits, 40 characters at most.',
  kind_invalid: 'Choose what the company is.',
  domain_invalid: 'Enter the email domain of the company, for example alder-custody.example. No address, no https.',
  email_not_at_domain: 'The work email must be at the company domain you entered, or at a subdomain of it.',
  name_invalid: 'Enter your own name, 60 characters at most.',
  passkey_rejected: 'The passkey was not accepted. Use a hardware security key and try again.',
  device_bound_required: 'An Owner needs a hardware security key. A passkey that syncs to a cloud account is not accepted.',
  intent_invalid: 'This application is not one this site issued, or it was changed on the way. Start again.',
  intent_expired: 'This application is older than 7 days. Start again.',
  dns_not_proved: 'The record is not there yet on both resolvers, or its value differs. DNS changes can take some minutes. Check the name and the value, then try again.',
  domain_taken: 'An organisation already exists for this domain. Ask its Owner to invite you, or write to Ophis.',
  invite_invalid: 'This application code is not one Ophis issued, or it is older than 14 days. Ask Ophis for a new one.',
  invite_used: 'This application code was already used. Ask Ophis for a new one.',
  too_many: 'Too many DNS checks for this domain in the last hour. Try again later.',
  not_stored: 'This application was already used. Sign in with the passkey you created for it.',
  second_key: 'The first Owner needs two passkeys. Add the second under Organisation, My passkeys.',
  proof_or_owner: 'One of two things is still missing: the signature of the recovery wallet, or a second Owner with two passkeys.',
  already_submitted: 'The organisation is already under review.',
  not_unverified: 'The organisation is already verified.',
  first_passkey_gone: 'The first Owner passkey is no longer active, so a wallet cannot confirm it. Enrol a second Owner with two passkeys instead.',
  unverified: 'This opens once Ophis has verified the organisation.',
}
const told = (data: { error?: string }) => SAY[data.error ?? ''] ?? say(data)
// The reasons the operator can give, from the server's fixed list.
const REASON: Record<string, string> = {
  entity_not_found: 'The company was not found in the register under this name and number.',
  details_differ: 'The legal name, the number or the country differ from the register.',
  authority_unclear: 'It is not shown that the applicant may act for the company.',
  wallet_differs: 'The recovery wallet or the three words differ from what the signers confirmed.',
  declaration_needed: 'A signed declaration is needed.',
  not_eligible: 'The company is outside what Ophis can serve.',
}
const KIND: Record<string, string> = { partner: 'Crypto business', institution: 'Financial institution' }

// ---- /apply: no session ----

const KEPT = 'ophis-business-application' // the application of this browser: the server's own text, nothing secret
const kept = () => {
  try {
    return localStorage.getItem(KEPT) ?? ''
  } catch {
    return ''
  }
}
const keep = (intent: string) => {
  try {
    intent ? localStorage.setItem(KEPT, intent) : localStorage.removeItem(KEPT)
  } catch {
    // storage is blocked: the resume link still works
  }
}
interface DnsRecord { name: string; type: string; value: string }
const FIELDS = { invite: '', legalName: '', country: '', registration: '', kind: 'partner', domain: '', email: '', name: '' }

export function Apply() {
  const [form, setForm] = useState(FIELDS)
  const [intent, setIntent] = useState(() => (location.hash.length > 1 ? location.hash.slice(1) : kept()))
  const [record, setRecord] = useState<DnsRecord>()
  const [expiresAt, setExpiresAt] = useState<number>()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [problem, setProblem] = useState(typeof PublicKeyCredential === 'undefined' ? 'This browser cannot use passkeys. Use a current version of Chrome, Edge, Firefox or Safari.' : '')
  const set = (key: keyof typeof FIELDS) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setProblem('')
    try {
      setProblem((await action()) ?? '')
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }
  const check = useCallback((sealed: string, quiet = false) => run(async () => {
    const result = await api<{ state?: string; error?: string; record?: DnsRecord }>('/api/apply/check', { intent: sealed })
    if (result.status === 200) {
      keep('')
      return setDone(true)
    }
    if (result.data.record) setRecord(result.data.record)
    else if (['intent_invalid', 'intent_expired', 'domain_taken', 'not_stored', 'invite_used'].includes(result.data.error ?? '')) {
      // Not an application any more: changed, expired, used, or its domain taken. Any other failure keeps it.
      keep('')
      setIntent('')
    }
    if (!(quiet && result.data.error === 'dns_not_proved')) return told(result.data)
  }), [])
  // A resumed application (the link, or this browser's own): one check shows the record, or finishes.
  useEffect(() => {
    if (intent && !record) void check(intent, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const begun = await api<{ seat: string; options: PublicKeyCredentialCreationOptionsJSON; error?: string }>('/api/apply', form)
      if (begun.status !== 200) return told(begun.data)
      const passkey = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(begun.data.options) })) as PublicKeyCredential
      const made = await api<{ intent: string; record: DnsRecord; expiresAt: number; error?: string }>('/api/apply', { ...form, seat: begun.data.seat, response: passkey.toJSON() })
      if (made.status !== 200) return told(made.data)
      keep(made.data.intent)
      setIntent(made.data.intent)
      setRecord(made.data.record)
      setExpiresAt(made.data.expiresAt)
    })
  }
  const copy = (what: string, text: string) => navigator.clipboard.writeText(text).then(() => setCopied(what), () => setCopied(''))
  const resume = `${location.origin}/apply#${intent}`

  return (
    <section className="recover">
      <header className="ph"><div>
        <span className="cap eyebrow">Apply</span>
        <h1 className="h-page">Open an organisation, <em>prove your company domain</em>.</h1>
        <p className="lede">For companies only, by invitation: Ophis gives you an application code. You enter the company, create a passkey on a hardware security key, and your DNS administrator publishes one record. Nothing is stored until that record is found.</p>
      </div></header>
      {problem && <Problem>{problem}</Problem>}
      {done ? (
        <div className="panel stack">
          <h2 className="h-panel">The domain is proved and the organisation exists.</h2>
          <p>It is not yet verified. Sign in with the passkey you just created, add a second passkey, and follow the Onboarding page.</p>
          <div><a className="btn primary md" href="/#/"><Icon name="fingerprint" size={16} />Sign in</a></div>
        </div>
      ) : intent ? (
        <div className="panel stack">
          <h2 className="h-panel">Ask your DNS administrator to publish this record.</h2>
          {record ? (
            <>
              <dl className="kv">
                <dt>Type</dt><dd>{record.type}</dd>
                <dt>Name</dt><dd className="mono">{record.name}</dd>
                <dt>Value</dt><dd className="mono">{record.value}</dd>
              </dl>
              <div className="acts">
                <button className="btn ghost md" type="button" onClick={() => copy('name', record.name)}><Icon name="clipboard-check" size={16} />{copied === 'name' ? 'Copied' : 'Copy the name'}</button>
                <button className="btn ghost md" type="button" onClick={() => copy('value', record.value)}><Icon name="clipboard-check" size={16} />{copied === 'value' ? 'Copied' : 'Copy the value'}</button>
              </div>
              <p className="note warn" role="status"><Icon name="info" /><span className="grow">The value belongs to the passkey you just created. A record from an earlier application does not work, and this record works for no other passkey. Keep the security key.</span></p>
            </>
          ) : <p className="fine" role="status">Reading the application.</p>}
          <div className="acts">
            <button className="btn primary md" type="button" disabled={busy} onClick={() => check(intent)}><Icon name="shield-check" size={16} />Check DNS</button>
            <button className="btn ghost md" type="button" disabled={busy} onClick={() => { keep(''); setIntent(''); setRecord(undefined); setProblem('') }}>Start again</button>
          </div>
          <label className="field">Link to come back to this application{expiresAt ? `, valid until ${minute(expiresAt)}` : ', valid 7 days'}
            <input className="input mono" readOnly value={resume} onFocus={(event) => event.target.select()} />
          </label>
          <div><button className="btn ghost md" type="button" onClick={() => copy('link', resume)}><Icon name="clipboard-check" size={16} />{copied === 'link' ? 'Copied' : 'Copy the link'}</button></div>
          <p className="fine"><Icon name="info" size={16} /><span>Two independent DNS resolvers must both show the record. Once they do, the organisation is created and you sign in with your passkey. This browser remembers the application.</span></p>
        </div>
      ) : (
        <form className="panel stack" onSubmit={start}>
          <label className="field">Application code, from Ophis
            <input className="input mono" value={form.invite} required maxLength={400} spellCheck={false} autoComplete="off" onChange={set('invite')} />
          </label>
          <label className="field">Legal name of the company
            <input className="input" value={form.legalName} required maxLength={120} autoComplete="organization" onChange={set('legalName')} />
          </label>
          <label className="field">Country, two-letter code
            <input className="input" value={form.country} required maxLength={2} placeholder="LU" autoComplete="country" spellCheck={false} onChange={set('country')} />
          </label>
          <label className="field">Registration number or LEI
            <input className="input mono" value={form.registration} required maxLength={40} spellCheck={false} autoComplete="off" onChange={set('registration')} />
          </label>
          <label className="field">The company is a
            <select className="input" value={form.kind} onChange={set('kind')}>
              {Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">Email domain of the company
            <input className="input mono" value={form.domain} required maxLength={253} placeholder="company.example" spellCheck={false} autoComplete="off" onChange={set('domain')} />
          </label>
          <label className="field">Your work email, at that domain
            <input className="input" type="email" value={form.email} required maxLength={254} autoComplete="email" onChange={set('email')} />
          </label>
          <label className="field">Your name
            <input className="input" value={form.name} required maxLength={60} autoComplete="name" onChange={set('name')} />
          </label>
          <p>The next step creates your passkey, which makes you the first Owner. Use a hardware security key. Then you get one DNS record to publish at the company domain: it proves the domain, and that this passkey is the one your company means.</p>
          <div><button className="btn primary md" type="submit" disabled={busy || typeof PublicKeyCredential === 'undefined'}><Icon name="key-round" size={16} />Create the passkey and the DNS record</button></div>
        </form>
      )}
      <p className="fine"><Icon name="info" size={16} /><span>Already a member? <a href="/#/">Sign in</a>. Invited by a colleague? Open the link they gave you.</span></p>
    </section>
  )
}

// ---- the Onboarding page and the KYB record ----

interface KybRow { legalName: string; registration: string | null; country: string; tier: string; source: string; evidenceSha256: string | null; decision: string; reason: string | null; decidedAt: number | null; nextReview: number | null }
interface View {
  company: { legalName: string; kind: string; country: string | null; registration: string | null; domain: string | null; domainVerifiedAt: number | null }
  first: { phrase: string[]; credentialHash: string; active: boolean } | null
  wallet: { chainId: number; chain: string; address: string; kind: string; label: string; inForce: boolean; threshold?: number; owners?: number } | null
  missing: string | null
  review: { status: 'not_submitted' | 'under_review' | 'more_information' | 'verified'; since: number | null; reason: string | null }
  record: KybRow | null
  chains: { id: number; name: string }[]
}
function useOnboarding(onSignedOut: () => void) {
  const [view, setView] = useState<View>()
  const [problem, setProblem] = useState('')
  const load = useCallback(async () => {
    const result = await api<View & { error?: string }>('/api/onboarding')
    if (result.status === 401) return onSignedOut()
    if (result.status === 200) return setView(result.data)
    setProblem(result.status === 403 ? 'This page is open to Owners and Compliance officers.' : 'The page could not be loaded. Reload it.')
  }, [onSignedOut])
  useEffect(() => void load(), [load])
  return { view, problem, setProblem, load }
}
const Step = ({ icon, title, done, later, children }: { icon: string; title: string; done?: boolean; later?: boolean; children: ReactNode }) => (
  <div className="srow"><Icon name={icon} size={20} /><b>{title}</b><Status>{later ? 'Later' : done ? 'Done' : 'Pending'}</Status><div className="stack">{children}</div></div>
)

export function Onboarding({ owner, onSignedOut }: { owner: boolean; onSignedOut: () => void }) {
  const { view, problem, setProblem, load } = useOnboarding(onSignedOut)
  const [wallet, setWallet] = useState({ chainId: 0, address: '', label: '', custodian: false })
  const [issued, setIssued] = useState<{ link: string; expiresAt: number }>()
  const [copied, setCopied] = useState(false)
  const act = async (path: string, body: unknown, then: (data: never) => void) => {
    setProblem('')
    try {
      const out = await sensitive<{ error?: string }>(path, body)
      if (out.status === 401) return onSignedOut()
      if (out.status !== 200) return setProblem(told(out.data))
      then(out.data as never)
      await load()
    } catch {
      setProblem(CANCELLED)
    }
  }
  const name = (event: FormEvent) => {
    event.preventDefault()
    void act('/api/onboarding/wallet', { ...wallet, chainId: wallet.chainId || view!.chains[0]?.id, address: wallet.address.trim(), label: wallet.label.trim() }, setIssued)
  }
  if (!view) return problem ? <div className="stack"><Problem>{problem}</Problem></div> : null
  const { company, first, review, missing } = view
  const verified = review.status === 'verified'
  const keys = verified || (missing !== 'second_key' && missing !== 'not_found')
  const proved = verified || missing === null

  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Onboarding</span>
        <h1 className="h-page">From application <em>to a verified organisation</em>.</h1>
        <p className="lede">{verified ? 'This organisation is verified.' : 'Until Ophis has reviewed the organisation you can add passkeys, invite members, name the recovery wallet and use Support. Everything else opens after the review.'}</p>
      </div></header>
      {problem && <div className="stack"><Problem>{problem}</Problem></div>}
      <section className="sg" aria-labelledby="ob-h">
        <header><Tile name="clipboard-check" /><div><h2 className="h-panel" id="ob-h">Steps</h2><p>Each step shows what the server holds now.</p></div></header>
        <div>
          <Step icon="building-2" title="Company and domain" done>
            <p>{company.legalName}{company.kind ? `, ${KIND[company.kind] ?? company.kind}` : ''}{company.country ? `, ${company.country}` : ''}{company.registration ? `, number ${company.registration}` : ''}.</p>
            <p>{company.domain ? `Domain ${company.domain}, proved by its DNS record on ${day(company.domainVerifiedAt!)}.` : 'Created by Ophis for this local build, without an application.'}</p>
          </Step>
          <Step icon="key-round" title="Passkeys" done={keys}>
            <p>{keys ? 'The first Owner holds two hardware keys.' : 'The first Owner needs two hardware keys. Add the second one now: until then this seat can do nothing else.'}</p>
            {!keys && <p><a className="btn ghost sm" href="/#/organisation">Open Organisation, My passkeys</a></p>}
          </Step>
          <Step icon="wallet" title="Recovery wallet or second Owner" done={proved}>
            {view.wallet ? <p>{view.wallet.label}: {kindOf(view.wallet)}, <span className="mono">{view.wallet.address}</span> on {view.wallet.chain}. {view.wallet.inForce ? 'It is the recovery wallet in force.' : 'It signed the activation. It becomes the recovery wallet when Ophis approves the organisation.'}</p>
              : <p>{proved ? 'A second Owner with two hardware keys is enrolled. No recovery wallet is named.' : 'Name the wallet that restores access if every Owner is locked out, and let it sign once. Or invite a second Owner, who needs two hardware keys.'}</p>}
            {!verified && first && (
              <>
                <p className="phrase" aria-label="The three words of the first Owner passkey">{first.phrase.map((word, index) => <span key={index}>{word}</span>)}</p>
                <p className="fine"><Icon name="info" size={16} /><span>The signers of the wallet compare these three words, and this passkey hash, with the signing page before they sign: <span className="mono">{first.credentialHash}</span></span></p>
              </>
            )}
            {!verified && owner && keys && first?.active && !issued && (
              <form className="stack" onSubmit={name}>
                <label className="field">Chain
                  <select className="input" value={wallet.chainId || view.chains[0]?.id} onChange={(event) => setWallet({ ...wallet, chainId: Number(event.target.value) })}>
                    {view.chains.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}
                  </select>
                </label>
                <label className="field">Wallet address
                  <input className="input mono" value={wallet.address} required maxLength={42} placeholder="0x" spellCheck={false} autoComplete="off" onChange={(event) => setWallet({ ...wallet, address: event.target.value })} />
                </label>
                <label className="field">A name for it
                  <input className="input" value={wallet.label} required maxLength={40} onChange={(event) => setWallet({ ...wallet, label: event.target.value })} />
                </label>
                <label className="check"><input type="checkbox" checked={wallet.custodian} onChange={(event) => setWallet({ ...wallet, custodian: event.target.checked })} /><span>A custodian holds this wallet. This is your declaration. Ophis does not check it.</span></label>
                <div><button className="btn primary md" type="submit"><Icon name="wallet" size={16} />{view.wallet ? 'Name another wallet' : 'Create the signing link'}</button></div>
              </form>
            )}
            {issued && (
              <>
                <label className="field">Signing link, valid until {minute(issued.expiresAt)}
                  <input className="input mono" readOnly value={issued.link} onFocus={(event) => event.target.select()} />
                </label>
                <div className="acts">
                  <button className="btn ghost md" type="button" onClick={() => navigator.clipboard.writeText(issued.link).then(() => setCopied(true), () => setCopied(false))}><Icon name="clipboard-check" size={16} />{copied ? 'Copied' : 'Copy the link'}</button>
                  <button className="btn ghost md" type="button" onClick={() => { setIssued(undefined); void load() }}>The wallet has signed</button>
                </div>
                <p className="fine"><Icon name="info" size={16} /><span>Give the link to the people who hold the wallet. Read them the three words. A Safe signs inside the Safe interface: add the signing page as a custom app and paste the link.</span></p>
              </>
            )}
          </Step>
          <Step icon="scroll-text" title="Declaration" later><p>A signed declaration of the company, sealed in your browser. It arrives with milestone 5b.</p></Step>
          <Step icon="shield-check" title="Review" done={verified}>
            <p role="status">{review.status === 'verified' ? (view.record?.decidedAt ? `Verified on ${day(view.record.decidedAt)}.${view.record.nextReview ? ` Next review ${day(view.record.nextReview)}.` : ''}` : 'Verified.')
              : review.status === 'under_review' ? `Under review since ${minute(review.since!)}. Ophis compares the company, the domain, the three words and the recovery wallet.`
              : review.status === 'more_information' ? `More information asked: ${REASON[review.reason ?? ''] ?? 'see the message from Ophis.'} Change what is needed, then submit again.`
              : 'Not submitted.'}</p>
            {owner && (review.status === 'not_submitted' || review.status === 'more_information') && (
              <div className="acts">
                <button className="btn primary md" type="button" disabled={missing !== null} title="Asks for your passkey, then sends the organisation to Ophis for review." onClick={() => act('/api/onboarding/submit', {}, () => undefined)}><Icon name="shield-check" size={16} />Submit for review</button>
                {missing && <span className="fine">{SAY[missing] ?? 'A step above is not done.'}</span>}
              </div>
            )}
          </Step>
        </div>
      </section>
    </>
  )
}

/** The Compliance page's block, for an Owner and a Compliance officer: the result of the verification, never a document. */
export function KybRecord() {
  const [view, setView] = useState<View | null>()
  useEffect(() => void api<View>('/api/onboarding').then((result) => setView(result.status === 200 ? result.data : null)), [])
  if (view === undefined) return null
  const r = view?.record
  return (
    <Section icon="shield-check" title="KYB record" hint="What Ophis recorded when it verified your organisation. No document is stored.">
      {!view ? <p className="fine">The KYB record is open to Owners and Compliance officers.</p>
      : !r ? <p className="fine">No record yet. It appears when Ophis has reviewed the organisation. See <a href="/#/onboarding">Onboarding</a>.</p>
      : (
        <dl className="kv">
          <dt>Legal name</dt><dd>{r.legalName}</dd>
          <dt>LEI or registration number</dt><dd className="mono">{r.registration ?? 'None'}</dd>
          <dt>Country</dt><dd>{r.country}</dd>
          <dt>Tier</dt><dd>{r.tier === 'enhanced' ? 'Enhanced' : 'Standard'}</dd>
          <dt>Verified on</dt><dd>{r.decision === 'approved' && r.decidedAt ? stamp(r.decidedAt) : 'Not verified'}</dd>
          <dt>Next review</dt><dd>{r.nextReview ? day(r.nextReview) : 'Not set'}</dd>
          <dt>Source</dt><dd>{SOURCE[r.source] ?? r.source}</dd>
          <dt>Evidence SHA-256</dt><dd className="mono">{r.evidenceSha256 ?? 'None'}</dd>
          <dt>Decision</dt><dd>{r.decision === 'approved' ? 'Approved' : r.decision === 'rejected' ? 'Refused' : 'More information asked'}{r.reason ? `: ${REASON[r.reason] ?? r.reason}` : ''}</dd>
        </dl>
      )}
    </Section>
  )
}
const SOURCE: Record<string, string> = { registry: 'Company register', gleif: 'GLEIF (LEI)', supervisor_register: 'Public register of a supervisor', declaration: 'Signed declaration' }

/** An organisation that Ophis froze, or that is closed: nothing is reachable but the sign-out. */
export function Closed({ kind, onSignOut }: { kind: string; onSignOut: () => void }) {
  return (
    <section className="recover">
      <header className="ph"><div>
        <span className="cap eyebrow">Organisation</span>
        <h1 className="h-page">{kind === 'org_frozen' ? <>This organisation <em>is frozen</em>.</> : <>This organisation <em>is closed</em>.</>}</h1>
        <p className="lede">{kind === 'org_frozen' ? 'Ophis froze it. Nothing can be read or changed until it is unfrozen. The freeze is a row in your audit log.' : 'Its application was refused, or it was archived. Nothing can be read or changed.'}</p>
      </div></header>
      <div className="panel stack">
        <p>If you think this is a mistake, write to Ophis by email.</p>
        <div><button className="btn primary md" type="button" onClick={onSignOut}><Icon name="log-out" size={16} />Sign out</button></div>
      </div>
    </section>
  )
}
