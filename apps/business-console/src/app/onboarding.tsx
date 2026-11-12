// Milestone 5a: the public application page (/apply), the Onboarding page, the KYB record block of the Compliance
// page, and the plain page of an organisation that is frozen or closed. Every value shown comes from the server.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { kindOf } from './pages.tsx'
import { api, CANCELLED, Icon, minute, PROVIDER, say, Section, sensitive, stamp, Status, Tile } from './ui.tsx'

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
  single_key: 'A recovery wallet with a single key is accepted only while the organisation has one member. Name a Safe or a custodian wallet instead.',
  declaration: 'The signed declaration is still missing. Print it, have it signed, then seal and upload the scan.',
  not_sealed: 'This is not a file sealed by this page. Choose the scan again and use "Seal and upload".',
  too_large: 'The file is larger than 10 MB. Scan the page again at a lower resolution.',
  not_configured: 'Sealing is not configured here yet. No file can be uploaded.',
  key_changed: 'This page was built for another sealing key. Reload it and try again.',
  already_submitted: 'The organisation is already under review.',
  not_unverified: 'The organisation is already verified.',
  first_passkey_gone: 'The first Owner passkey is no longer active, so a wallet cannot confirm it. Enrol a second Owner with two passkeys instead.',
  unverified: 'This opens once Ophis has verified the organisation.',
  invalid: 'That is already the company sign-in.',
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
  first: { phrase: string[]; credentialHash: string; active: boolean; name: string } | null
  signin: { setting: 'none' | 'microsoft' | 'google' | null; tenant: string | null }
  wallet: { chainId: number; chain: string; address: string; kind: string; label: string; inForce: boolean; threshold?: number; owners?: number } | null
  missing: string | null
  review: { status: 'not_submitted' | 'under_review' | 'more_information' | 'verified'; since: number | null; reason: string | null }
  record: KybRow | null
  // Milestone 5b: the sealed declaration as the server knows it, and every download of the operator with its reason.
  sealed: { id: string; size: number; sha256: string; key: string; generation: string; at: number } | null
  downloads: { at: number; item: string; reason: string }[]
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

// ---- milestone 5b: sealing in the browser (key-custody.md section 3) ----
// The recipient (the public key a file is sealed to) is a constant of this bundle, per hostname: never fetched, never
// read from the API. localhost: the test recipient that "pnpm seed" made, compiled in by the build from .env.local (its
// identity file stays on the developer's machine). No other hostname has a recipient yet: there the page says so and
// seals nothing. The key's fingerprint is the SHA-256 of the recipient string.
const RECIPIENTS: Record<string, string | undefined> = { localhost: import.meta.env.VITE_SEAL_LOCAL }
const CLEAR_MAX = 10 * 1024 * 1024
// PDF, PNG or JPEG, by the first bytes of the file. Only this page can check it: the server never sees the clear file.
const MAGIC = [[0x25, 0x50, 0x44, 0x46, 0x2d], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0xff, 0xd8, 0xff]]
const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
/** The file, encrypted here in the age v1 format to the one recipient. The library loads when a file is sealed, from this origin. */
async function sealed(clear: Uint8Array, recipient: string) {
  const age = await import('age-encryption')
  const encrypter = new age.Encrypter()
  encrypter.addRecipient(recipient)
  return encrypter.encrypt(clear)
}

// Milestone 5b: the declaration, one page to print, sign and scan (the print stylesheet leaves it alone on the page, like
// the recovery sheet). Every value is the server's, shown as text: nothing on it can be typed or changed here.
function Declaration({ view }: { view: View }) {
  const { company, first, wallet, signin } = view
  return (
    <div className="groups"><section className="sg printable" aria-labelledby="dc-h">
      <header><Tile name="scroll-text" /><div><h2 className="h-panel" id="dc-h">Declaration to print</h2><p>One page. A person who may bind the company signs it. Then scan it, and seal and upload the scan in the step "Declaration".</p>
        <p><button className="btn ghost sm" type="button" onClick={() => print()}><Icon name="download" size={16} />Print the declaration</button></p></div></header>
      <article className="sheet" aria-label="Declaration">
        <h3 className="h-panel">Declaration of the company to Ophis</h3>
        <dl className="kv">
          <dt>Legal name</dt><dd>{company.legalName}</dd>
          <dt>Registration number or LEI</dt><dd className="mono">{company.registration ?? 'none'}</dd>
          <dt>Country</dt><dd>{company.country ?? 'none'}</dd>
          <dt>Email domain</dt><dd className="mono">{company.domain ?? 'none'}</dd>
          <dt>First Owner</dt><dd>{first?.name ?? 'none'}</dd>
          <dt>First Owner passkey (hash)</dt><dd className="mono">{first?.credentialHash ?? 'none'}</dd>
          <dt>Recovery wallet</dt><dd className="mono">{wallet ? wallet.address : 'none'}</dd>
          <dt>Chain</dt><dd>{wallet?.chain ?? 'none'}</dd>
          <dt>Company sign-in</dt><dd>{PROVIDER[signin.setting ?? ''] ?? 'none'}</dd>
        </dl>
        <p>The undersigned declares that the details above are those of the company, that the first Owner named above acts for the company in the Ophis Business console, and that the undersigned may bind the company.</p>
        <dl className="kv sign">
          <dt>Name of the signatory</dt><dd />
          <dt>Role</dt><dd />
          <dt>Date</dt><dd />
          <dt>Signature</dt><dd />
        </dl>
        <p className="fine">Ophis is a software provider. It is not a crypto-asset service provider.</p>
      </article>
    </section></div>
  )
}
// end of the declaration sheet

export function Onboarding({ owner, onSignedOut }: { owner: boolean; onSignedOut: () => void }) {
  const { view, problem, setProblem, load } = useOnboarding(onSignedOut)
  const [wallet, setWallet] = useState({ chainId: 0, address: '', label: '', custodian: false })
  const [issued, setIssued] = useState<{ link: string; expiresAt: number }>()
  const [copied, setCopied] = useState(false)
  // The sealing key of this bundle: its fingerprint, null where this hostname has none, undefined until it is computed.
  const recipient = RECIPIENTS[location.hostname]
  const [sealKey, setSealKey] = useState<string | null | undefined>(recipient ? undefined : null)
  useEffect(() => void (recipient && sha256(new TextEncoder().encode(recipient)).then(setSealKey)), [recipient])
  const [scan, setScan] = useState<File>()
  const [sealing, setSealing] = useState(false)
  const act = async (path: string, body: unknown, then: (data: never) => void, headers?: Record<string, string>) => {
    setProblem('')
    try {
      const out = await sensitive<{ error?: string }>(path, body, headers)
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
  // The signed scan: checked and sealed here, then sent. What leaves this browser is the sealed file and nothing else.
  const upload = async (event: FormEvent) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement // emptied after the upload: the chosen file must stay in the field until then
    if (!scan || !recipient || !sealKey) return
    setProblem('')
    setSealing(true)
    try {
      const clear = new Uint8Array(await scan.arrayBuffer())
      if (clear.length > CLEAR_MAX) return setProblem('The file is larger than 10 MB. Scan the page again at a lower resolution.')
      if (!MAGIC.some((magic) => magic.every((byte, index) => clear[index] === byte))) return setProblem('Choose the scan as a PDF, PNG or JPEG file.')
      let file
      try {
        file = await sealed(clear, recipient)
      } catch {
        return setProblem('The file could not be sealed in this browser. Nothing was sent.')
      }
      await act('/api/onboarding/declaration', file, () => { form.reset(); setScan(undefined) }, { 'x-seal-key': sealKey })
    } finally {
      setSealing(false)
    }
  }
  // The company sign-in: off to the provider with the Owner's own company account, or "none" at once.
  const signIn = async (provider: string) => {
    setProblem('')
    try {
      const begun = await sensitive<{ url?: string; error?: string }>('/api/company/start', { provider })
      if (begun.status === 401) return onSignedOut()
      if (begun.status === 200 && begun.data.url) return location.assign(begun.data.url)
      setProblem(told(begun.data))
    } catch {
      setProblem(CANCELLED)
    }
  }
  if (!view) return problem ? <div className="stack"><Problem>{problem}</Problem></div> : null
  const { company, first, review, missing, signin } = view
  const verified = review.status === 'verified'
  const keys = verified || (missing !== 'second_key' && missing !== 'not_found')
  const proved = verified || missing === null || missing === 'declaration' // the declaration is asked for last

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
          <Step icon="building-2" title="Company sign-in" done={signin.setting !== null}>
            <p>{PROVIDER[signin.setting ?? ''] ? `${PROVIDER[signin.setting!]}: members you invite sign in once with their company account at ${company.domain}, then create a passkey, and you approve. Pinned to ${signin.setting === 'google' ? 'the domain' : 'the tenant'} ${signin.tenant}. Your own company account is linked to your seat.`
              : signin.setting === 'none' ? 'None: members you invite create a passkey and send you three words, which you type.'
              : 'Choose how a new member shows who they are. With Microsoft or Google they sign in once with their company account, and no words are needed. Passkeys stay the only way to sign in.'}</p>
            {!verified && owner && keys && (
              <div className="acts">
                {(['microsoft', 'google'] as const).filter((p) => p !== signin.setting).map((p) => <button key={p} className="btn ghost md" type="button" title={`You sign in with your own ${PROVIDER[p]} company account. That pins your organisation there.`} onClick={() => signIn(p)}><Icon name="building-2" size={16} />{signin.setting === null ? 'Continue with' : 'Change to'} {PROVIDER[p]}</button>)}
                {signin.setting !== 'none' && <button className="btn ghost md" type="button" onClick={() => act('/api/policy/company', {}, () => undefined)}>{signin.setting === null ? 'None: three words' : 'Change to none: three words'}</button>}
              </div>
            )}
            {!verified && owner && !keys && <p className="fine"><Icon name="info" size={16} /><span>Add your second passkey first.</span></p>}
            {verified && <p className="fine"><Icon name="info" size={16} /><span>A change now takes two people: Organisation, Company sign-in.</span></p>}
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
          <Step icon="scroll-text" title="Declaration" done={verified || Boolean(view.sealed)}>
            <p>Print the declaration below and have it signed by a person who may bind the company. Scan it. The scan is encrypted in this browser before it is sent: the server keeps it sealed and holds no key that opens it.</p>
            {!verified && owner && keys && sealKey && (
              <form className="stack" onSubmit={upload}>
                <label className="field">Signed scan: PDF, PNG or JPEG, 10 MB at most
                  <input className="input" type="file" required accept="application/pdf,image/png,image/jpeg" onChange={(event) => setScan(event.target.files?.[0])} />
                </label>
                <div><button className="btn primary md" type="submit" disabled={!scan || sealing} title="Encrypts the file in this browser, asks for your passkey, then sends the sealed file."><Icon name="shield-check" size={16} />{sealing ? 'Sealing' : 'Seal and upload'}</button></div>
              </form>
            )}
            <p className="fine" role="status"><Icon name="info" size={16} /><span>{sealKey ? <>Sealed to key <span className="mono">{sealKey}</span>. Only the holder of that key can open the file, offline.</> : sealKey === null ? 'Sealing is not configured for this address yet. No file can be uploaded here.' : 'Reading the sealing key.'}</span></p>
            {view.sealed && <SealedItem item={view.sealed} />}
            {view.sealed && !verified && owner && <p className="fine">A new upload replaces this file. If the organisation is under review, submit it again.</p>}
          </Step>
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
      {owner && !verified && first && <Declaration view={view} />}
    </>
  )
}

/** What the server knows of the sealed declaration. It holds the sealed file and no key that opens it. */
const SealedItem = ({ item }: { item: NonNullable<View['sealed']> }) => (
  <dl className="kv">
    <dt>Uploaded on</dt><dd>{stamp(item.at)}</dd>
    <dt>Size</dt><dd>{item.size.toLocaleString('en-GB')} bytes, sealed</dd>
    <dt>SHA-256 of the sealed file</dt><dd className="mono">{item.sha256}</dd>
    <dt>Sealed to key</dt><dd className="mono">{item.key} ({item.generation})</dd>
  </dl>
)

/** The Compliance page's block, for an Owner and a Compliance officer: the result of the verification, the sealed declaration and who took it. */
export function KybRecord() {
  const [view, setView] = useState<View | null>()
  useEffect(() => void api<View>('/api/onboarding').then((result) => setView(result.status === 200 ? result.data : null)), [])
  if (view === undefined) return null
  const r = view?.record
  return (
    <Section icon="shield-check" title="KYB record" hint="What Ophis recorded when it verified your organisation. The one document stored is the signed declaration, sealed in your browser.">
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
      {view && (
        <>
          <h3 className="h-panel sub">Signed declaration</h3>
          {view.sealed ? <SealedItem item={view.sealed} /> : <p className="fine">None uploaded. See <a href="/#/onboarding">Onboarding</a>.</p>}
          <h3 className="h-panel sub">Downloads by the Ophis operator</h3>
          {view.downloads.length === 0 ? <p className="fine">None. Each download of the sealed file is listed here and in the audit log, with its reason.</p> : (
            <ul className="stack">
              {view.downloads.map((d) => <li key={`${d.at}${d.item}${d.reason}`}>{stamp(d.at)}: still sealed, for {d.reason}. <span className="fine">Item <span className="mono">{d.item.slice(0, 8)}</span>{d.item === view.sealed?.id ? '' : ', since replaced'}</span></li>)}
            </ul>
          )}
        </>
      )}
    </Section>
  )
}
const SOURCE: Record<string, string> = { registry: 'Company register', gleif: 'GLEIF (LEI)', supervisor_register: 'Public register of a supervisor', declaration: 'Signed declaration' }
