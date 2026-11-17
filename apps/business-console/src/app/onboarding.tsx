// Milestone 5a: the public application page (/apply), the Onboarding page, the KYB record block of the Compliance
// page, and the plain page of an organisation that is frozen or closed. Every value shown comes from the server.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { kindOf } from './pages.tsx'
import { api, CANCELLED, day, Icon, minute, ROLE, say, Section, sensitive, stamp, Status, Tile } from './ui.tsx'

const Problem = ({ children }: { children: string }) => <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{children}</span></p>

// What the server's refusals mean here, in the reader's words. Anything else falls back to the console's own list.
const SAY: Record<string, string> = {
  legal_name_invalid: 'Enter the legal name of the company, 2 to 120 characters.',
  country_invalid: 'Choose the country where the company is incorporated.',
  registration_invalid: 'Enter the company registration number: letters, digits, spaces, dots, dashes or slashes, 40 characters at most.',
  lei_invalid: 'This LEI is not valid: 20 letters and digits, and its check digits must match. Leave it empty if the company has none.',
  address_invalid: 'Enter the registered address of the company: street, postcode and city, 5 to 200 characters.',
  kind_invalid: 'Choose the type of business from the list.',
  domain_invalid: 'Enter the company domain, for example ophis.fi: the part of your work email after the @. No address, no https.',
  email_not_at_domain: 'Your work email must be at the company domain, or at a subdomain of it.',
  name_invalid: 'Enter your own name, 60 characters at most.',
  contact_invalid: 'Enter your position (2 to 60 characters) and your phone in international form, for example +352 621 123 456. A Telegram username, if you give one, has 5 to 32 letters, digits or underscores.',
  people_invalid: 'Name at most 4 more people. Each needs a name of 60 characters at most and the role Owner or Admin.',
  person_contact_invalid: 'Each person needs a position (2 to 60 characters) and a phone in international form, for example +352 621 123 456. A Telegram username, if given, has 5 to 32 letters, digits or underscores.',
  person_email_invalid: 'Each person needs a work email of their own at the company domain. Not yours, and not one given twice.',
  passkey_rejected: 'The passkey was not accepted. Try again, on this device, your phone or a security key.',
  device_bound_required: 'This organisation requires hardware security keys. A passkey that syncs to a cloud account is not accepted.',
  intent_invalid: 'This application is not one this site issued, or it was changed on the way. Start again.',
  intent_expired: 'This application is older than 7 days. Start again.',
  dns_not_proved: 'The record is not there yet on both resolvers, or its value differs. DNS changes can take some minutes. Check the name and the value, then try again.',
  domain_taken: 'An organisation already exists for this domain. Ask its Owner to invite you, or write to Ophis.',
  invite_invalid: 'This invitation code is not one Ophis issued, or it is older than 48 hours. Check the 12 characters, or ask Ophis for a new one.',
  invite_used: 'This invitation code was already used. Ask Ophis for a new one.',
  too_many: 'Too many DNS checks for this domain in the last hour. Try again later.',
  not_stored: 'This application was already used. Sign in with the passkey you created for it.',
  second_key: 'The first Owner needs two passkeys. Add the second under Organisation, My passkeys.',
  proof_or_owner: 'One of two things is still missing: the signature of the recovery wallet, or a second Owner with two passkeys.',
  single_key: 'A recovery wallet with a single key is accepted only while the organisation has one member and its application names nobody else. Name a Safe or a custodian wallet instead.',
  declaration: 'The signed declaration is still missing. Print it, have it signed, then seal and upload the scan.',
  not_sealed: 'This is not a file sealed by this page. Choose the scan again and use "Seal and upload".',
  too_large: 'The file is larger than 10 MB. Scan the page again at a lower resolution.',
  not_configured: 'Sealing is not configured here yet. No file can be uploaded.',
  key_changed: 'This page was built for another sealing key. Reload it and try again.',
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
  wallet_differs: 'The recovery wallet or the passkey hash differs from what the signers confirmed.',
  declaration_needed: 'A signed declaration is needed.',
  not_eligible: 'The company is outside what Ophis can serve.',
}
const KIND: Record<string, string> = { partner: 'Crypto business', institution: 'Financial institution' }
// What the company does (owner, 2026-11-17). The server sets the kind from it (BUSINESS in server/onboarding.ts).
const BUSINESS: Record<string, string> = {
  wallet: 'Wallet', exchange: 'Exchange', app: 'App or dApp', payments: 'Payments', protocol: 'DeFi protocol',
  fund: 'Fund or asset manager', vc: 'Venture capital', bank: 'Bank', broker: 'Broker', family_office: 'Family office', treasury: 'Company treasury',
}
// ISO 3166-1 alpha-2, and XK (Kosovo), named by the browser in English: the server stores the code.
const NAMES = new Intl.DisplayNames(['en'], { type: 'region' })
export const countryName = (code: string | null) => (code ? NAMES.of(code) ?? code : 'none')
const COUNTRIES = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW')
  .split(' ').map((code) => [code, countryName(code)]).sort((a, b) => a[1].localeCompare(b[1], 'en'))
// A person in words: name, position, role; the contact is for Ophis, not for the declaration.
const who = (p: { name: string; position?: string | null }) => (p.position ? `${p.name}, ${p.position}` : p.name)

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
const FIELDS = { invite: '', legalName: '', businessType: '', country: '', registration: '', lei: '', address: '', name: '', position: '', email: '', domain: '', phone: '', telegram: '' }
interface Person { name: string; position: string; email: string; phone: string; telegram: string; role: string }
const NOBODY: Person = { name: '', position: '', email: '', phone: '', telegram: '', role: 'admin' }
const after = (email: string) => email.split('@')[1] ?? ''

export function Apply() {
  const [form, setForm] = useState(FIELDS)
  const [people, setPeople] = useState<Person[]>([]) // besides the applicant: 0 to 4
  const person = (i: number, change: Partial<Person>) => setPeople(people.map((p, j) => (j === i ? { ...p, ...change } : p)))
  const [intent, setIntent] = useState(() => (location.hash.length > 1 ? location.hash.slice(1) : kept()))
  const [record, setRecord] = useState<DnsRecord>()
  const [expiresAt, setExpiresAt] = useState<number>()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [problem, setProblem] = useState(typeof PublicKeyCredential === 'undefined' ? 'This browser cannot use passkeys. Use a current version of Chrome, Edge, Firefox or Safari.' : '')
  const set = (key: keyof typeof FIELDS) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value })
  // The company domain follows the work email until it is edited: most companies' domain is the part after the @.
  const setEmail = (event: { target: { value: string } }) => setForm({ ...form, email: event.target.value, domain: form.domain === after(form.email) ? after(event.target.value) : form.domain })
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
  // skipDns: make the organisation now, without the DNS record (owner, 2026-11-17: the record is optional).
  const check = useCallback((sealed: string, quiet = false, skipDns = false) => run(async () => {
    const result = await api<{ state?: string; error?: string; record?: DnsRecord }>('/api/apply/check', { intent: sealed, ...(skipDns && { skipDns: true }) })
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
      const begun = await api<{ seat: string; options: PublicKeyCredentialCreationOptionsJSON; error?: string }>('/api/apply', { ...form, people })
      if (begun.status !== 200) return told(begun.data)
      const passkey = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(begun.data.options) })) as PublicKeyCredential
      const made = await api<{ intent: string; record: DnsRecord; expiresAt: number; error?: string }>('/api/apply', { ...form, people, seat: begun.data.seat, response: passkey.toJSON() })
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
        <p className="lede">For companies only, by invitation: Ophis gives you an invitation code. You enter the company, create a passkey (on this device, your phone or a security key), and Ophis reviews the company. Ophis stores nothing until you create the organisation.</p>
      </div></header>
      {problem && <Problem>{problem}</Problem>}
      {done ? (
        <div className="panel stack">
          <h2 className="h-panel">The organisation exists.</h2>
          <p>It is not yet verified. Sign in with the passkey you just created, add a second passkey, and follow the Onboarding page.</p>
          <div><a className="btn primary md" href="/#/"><Icon name="fingerprint" size={16} />Sign in</a></div>
        </div>
      ) : intent ? (
        <div className="panel stack">
          <h2 className="h-panel">Your passkey is ready. Create the organisation.</h2>
          <p>Ophis checks your company in its review before anything else opens. You do not need to change anything on your side.</p>
          <div className="acts">
            <button className="btn primary md" type="button" disabled={busy} onClick={() => check(intent, false, true)}><Icon name="building-2" size={16} />Create the organisation</button>
            <button className="btn ghost md" type="button" disabled={busy} onClick={() => { keep(''); setIntent(''); setRecord(undefined); setProblem('') }}>Start again</button>
          </div>
          <h3 className="h-panel sub">Optional: prove the company domain by DNS</h3>
          <p>If your DNS administrator can publish this record, check it instead: the organisation then shows a proved domain.</p>
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
              <p className="note warn" role="status"><Icon name="info" /><span className="grow">The value belongs to the passkey you just created. A record from an earlier application does not work, and this record works for no other passkey. Keep this passkey.</span></p>
            </>
          ) : <p className="fine" role="status">Reading the application.</p>}
          <div><button className="btn ghost md" type="button" disabled={busy} onClick={() => check(intent)}><Icon name="shield-check" size={16} />Check DNS and create</button></div>
          <label className="field">Link to come back to this application{expiresAt ? `, valid until ${minute(expiresAt)}` : ', valid 7 days'}
            <input className="input mono" readOnly value={resume} onFocus={(event) => event.target.select()} />
          </label>
          <div><button className="btn ghost md" type="button" onClick={() => copy('link', resume)}><Icon name="clipboard-check" size={16} />{copied === 'link' ? 'Copied' : 'Copy the link'}</button></div>
          <p className="fine"><Icon name="info" size={16} /><span>With the record, two independent DNS resolvers must both show it. Either way, the organisation is created and you sign in with your passkey. This browser remembers the application.</span></p>
        </div>
      ) : (
        <form className="panel stack" onSubmit={start}>
          <label className="field">Invitation code
            <span className="hint">12 characters Ophis sent you. It works once, for 48 hours.</span>
            <input className="input mono" value={form.invite} required maxLength={20} placeholder="XXXX-XXXX-XXXX" spellCheck={false} autoComplete="off" autoCapitalize="characters" onChange={set('invite')} />
          </label>
          <h2 className="h-panel">The company</h2>
          <label className="field">Legal name
            <input className="input" value={form.legalName} required maxLength={120} autoComplete="organization" onChange={set('legalName')} />
          </label>
          <label className="field">Type of business
            <select className="input" value={form.businessType} required onChange={set('businessType')}>
              <option value="" disabled>Choose a type</option>
              {Object.entries(BUSINESS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">Country of incorporation
            <select className="input" value={form.country} required onChange={set('country')}>
              <option value="" disabled>Choose a country</option>
              {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          <label className="field">Company registration number
            <span className="hint">As in the company register.</span>
            <input className="input mono" value={form.registration} required maxLength={40} spellCheck={false} autoComplete="off" onChange={set('registration')} />
          </label>
          <label className="field">LEI, if the company has one
            <span className="hint">The Legal Entity Identifier: 20 letters and digits. Leave it empty if there is none.</span>
            <input className="input mono" value={form.lei} maxLength={20} spellCheck={false} autoComplete="off" onChange={set('lei')} />
          </label>
          <label className="field">Registered address
            <span className="hint">Street, postcode and city, as in the company register.</span>
            <input className="input" value={form.address} required maxLength={200} autoComplete="street-address" onChange={set('address')} />
          </label>
          <h2 className="h-panel">You</h2>
          <label className="field">Your name
            <input className="input" value={form.name} required maxLength={60} autoComplete="name" onChange={set('name')} />
          </label>
          <label className="field">Your position
            <input className="input" value={form.position} required maxLength={60} placeholder="Chief Executive Officer" autoComplete="organization-title" onChange={set('position')} />
          </label>
          <label className="field">Your work email
            <input className="input" type="email" value={form.email} required maxLength={254} autoComplete="email" onChange={setEmail} />
          </label>
          <label className="field">Your phone
            <span className="hint">International form, with the country code.</span>
            <input className="input" type="tel" value={form.phone} required maxLength={24} placeholder="+352 621 123 456" autoComplete="tel" onChange={set('phone')} />
          </label>
          <label className="field">Your Telegram username, optional
            <input className="input" value={form.telegram} maxLength={33} placeholder="@username" spellCheck={false} autoComplete="off" onChange={set('telegram')} />
          </label>
          <label className="field">Company domain
            <span className="hint">The part of your work email after the @, filled in from it. The organisation is known by it: one organisation per company domain.</span>
            <input className="input mono" value={form.domain} required maxLength={253} placeholder="company.example" spellCheck={false} autoComplete="off" onChange={set('domain')} />
          </label>
          <fieldset className="field">
            <legend>Other people of the company, up to 4</legend>
            <div className="stack">
              <p className="fine">Ophis checks each one with the company. Each needs a work email at the company domain, and the role Owner or Admin. When Ophis approves, each gets a seat. You give them a one-time link, and your passkey check activates their passkey: no second person and no 72 hour wait, for 30 days after the approval.</p>
              {people.map((p, i) => (
                <div className="stack" key={i}>
                  <label className="field">Name of person {i + 2}
                    <input className="input" value={p.name} required maxLength={60} autoComplete="off" onChange={(event) => person(i, { name: event.target.value })} />
                  </label>
                  <label className="field">Position of person {i + 2}
                    <input className="input" value={p.position} required maxLength={60} autoComplete="off" onChange={(event) => person(i, { position: event.target.value })} />
                  </label>
                  <label className="field">Work email of person {i + 2}
                    <input className="input" type="email" value={p.email} required maxLength={254} autoComplete="off" onChange={(event) => person(i, { email: event.target.value })} />
                  </label>
                  <label className="field">Phone of person {i + 2}
                    <input className="input" type="tel" value={p.phone} required maxLength={24} placeholder="+352 621 123 456" autoComplete="off" onChange={(event) => person(i, { phone: event.target.value })} />
                  </label>
                  <label className="field">Telegram username of person {i + 2}, optional
                    <input className="input" value={p.telegram} maxLength={33} placeholder="@username" spellCheck={false} autoComplete="off" onChange={(event) => person(i, { telegram: event.target.value })} />
                  </label>
                  <label className="field">Role of person {i + 2}
                    <select className="input" value={p.role} onChange={(event) => person(i, { role: event.target.value })}>
                      <option value="admin">Admin</option><option value="owner">Owner</option>
                    </select>
                  </label>
                  <div><button className="btn ghost sm" type="button" onClick={() => setPeople(people.filter((_, j) => j !== i))}><Icon name="x" size={16} />Remove person {i + 2}</button></div>
                </div>
              ))}
              {people.length < 4 && <div><button className="btn ghost md" type="button" onClick={() => setPeople([...people, { ...NOBODY }])}><Icon name="user" size={16} />Add a person</button></div>}
            </div>
          </fieldset>
          <p>The next step creates your passkey, which makes you the first Owner: on this device, your phone or a security key. Then you create the organisation. Ophis stores nothing before that; this browser keeps your application so you can come back to it.</p>
          <div><button className="btn primary md" type="submit" disabled={busy || typeof PublicKeyCredential === 'undefined'}><Icon name="key-round" size={16} />Create the passkey</button></div>
        </form>
      )}
      <p className="fine"><Icon name="info" size={16} /><span>Already a member? <a href="/#/">Sign in</a>. Invited by a colleague? Open the link they gave you.</span></p>
    </section>
  )
}

// ---- the Onboarding page and the KYB record ----

interface KybRow { legalName: string; registration: string | null; country: string; tier: string; source: string; evidenceSha256: string | null; decision: string; reason: string | null; decidedAt: number | null; nextReview: number | null }
interface View {
  company: { legalName: string; kind: string; businessType: string | null; country: string | null; registration: string | null; lei: string | null; address: string | null; domain: string | null; domainVerifiedAt: number | null }
  first: { credentialHash: string; active: boolean; name: string; position: string | null } | null
  people: { name: string; email: string; role: string; position: string | null; phone: string | null; telegram: string | null }[]
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
// identity file stays on the developer's machine). pro.ophis.fi: PRODUCTION, the recipient the security-key ceremony
// printed (key-custody.md section 4, scripts/seal-ceremony.sh); wrangler.jsonc env.production SEAL_RECIPIENT holds the
// same string (a unit test compares them). Generation g1, made on 2026-11-16, fingerprint 9d1f8c22a7c3b24f…; a hostname with no
// recipient says so and seals nothing. The key's fingerprint is the SHA-256 of the recipient string.
const PRODUCTION = 'age1pq13n327qaepaj0czc8txdrc4n0rg9qz3mvrdllqattff47n6g6d73y9yqs0x56gxhjgqs2gsp2edk2c6jsggfzg3nk0phmw3du00x2039cxnl64zpeyrxscaqgu2qqre3xhz3vhnh7p327xzgzaewxrpgu3g4ufywfgccu5e7faqe8uvy6vzka2trvlgxdmzu4jlgg5kh9k9mtx6v75fkrafvh3v38zl0vvtsyj8s6fdgs0nye7d3q0k0f9n28kxgmrxuwzkmnewakn5agk38ac2mvswfp075ajhzx065hdny6qx37tzjgh5s2utpu200sty9kegucnxhhtl9vtmnpq37knpkuzs6h899w4y5qkszx0ujeffw4npst7ry66fgtsefy3ryk0yycnxf6fy3k3qd8d295en49tg6kp2dxpyef8c3unfrpj0fc43hk2p0ltwlla5rc97ny0vqvquglhs9l5aj5kvnr9menu26j4x9uhvrhqurjjy4wscde4fgk0jc4khsqxvx5ueu9fnzclsyhendh3g3a7s484lzf0prx83c30wnz5rr6xxjs82tk062x8w3q8q0ewe2nwdxr839sm5znp8tvnu6xge3xs4d4uqgh5affyaptcwv60zwdz2jt08pfgwenrev8fn95ct4hye3sneceq53meadqe3np29xnwe5v70plrxvcc4l9xk98yqnkfv8kj39xh0e32ka6ew4tj9v989ldfeedvnu93j5qwjtjglsjk64sdya6e9m5ex2h3yn2y9yag2udvkm9kg5sqmc32snxtwwjg6hhh9ac9zp4k6fvj6vu5u8fd3qpt9g352yjmw98ehpad3z2cs6vmynd266mqgrffevvwng4pg9tt7yzuxjsz56xzkm3k60a5spmkkemkterfheescf8ydnszjw0m4jpk7nrulryzjkp8dffs5k3gvrfqsdxhy68sgas4qgnq3hthedwketr5gtk0nq8v6y4wgawqq3zajuncruc4l4gkvh8yt958qqgpkt8hcayfwzmvpv33sgraqs3nesf23yp90xcgp2eazfetz974lg8vf3y8t8jrz4jjf4e5up3xzg22635tyamcnsnf3adkvfm27kv08pg20e68gfpv5gp8xr5ktrcafchy33m8fntt3u4d63hevc87lvmp5ndnd9ydx005wts74sk76rhkgja567qkrxx9s6y0egq3ycswtcagr0xfq9xxeqnput6j37q4mvrwa4ggzjecqfntpcy29sx8zdl5q2m02htz3ew84zq3pjjex77v5aas5fpqej2agdu4g2uxz7pswcupyq9e5jxegducyrxjpgq83v36gytnhpy3lqp2gt4ts3qex0lh9fy4zzydjqpjtfsxp768d55ujvspsyhltc65wtmzm8wzerg3dqw8hxvhmckkn7xyt0jqhrgsmryys6cgcagxzvq3zpgh3jugjdkqzr2mtx2kk4nvqsqxlurc3xfdknwz7uh5l6m97lvsh87wzwqmkgypdrzq0qgnd82k6lv5s3gpjn7aer3jlsqr24ds7yw7dlw425samfp6zvxn3q5xwe8mp5gk3205rzreuekqt78v2mex3pfmef60e930ugrv3paj83q5s7ygvtqlpck8eq9faxveyvdajnu6wumcn3547c3nkvtvvdvmfhspd6lecpuw8vmnx7yk3naujk98s7t6p33jnwe2hst5zqw7zyv3atux5g3llsxytdm5vhm76hjwggrmupml0tjvcwvr8rdmzadwvmmry297l8xvj4wc7j2evgpeqggpmrf4u8vd5g23qd2arq6kqlxrhnzsnvkq84flzqet8vq69tsk7y4f6tzmnx73xlw8qhx8gjmluvpxu3uxy7lmgawuuywjnruetx4nd7qf669r25lpaza2a5drgvtdy5q'
const RECIPIENTS: Record<string, string | undefined> = { localhost: import.meta.env.VITE_SEAL_LOCAL, 'pro.ophis.fi': PRODUCTION }
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
  const { company, first, wallet } = view
  return (
    <div className="groups"><section className="sg printable" aria-labelledby="dc-h">
      <header><Tile name="scroll-text" /><div><h2 className="h-panel" id="dc-h">Declaration to print</h2><p>One page. A person who may bind the company signs it. Then scan it, and seal and upload the scan in the step "Declaration".</p>
        <p><button className="btn ghost sm" type="button" onClick={() => print()}><Icon name="download" size={16} />Print the declaration</button></p></div></header>
      <article className="sheet" aria-label="Declaration">
        <h3 className="h-panel">Declaration of the company to Ophis</h3>
        <dl className="kv">
          <dt>Legal name</dt><dd>{company.legalName}</dd>
          {company.businessType && <><dt>Type of business</dt><dd>{BUSINESS[company.businessType] ?? company.businessType}</dd></>}
          <dt>Registration number</dt><dd className="mono">{company.registration ?? 'none'}</dd>
          {company.lei && <><dt>LEI</dt><dd className="mono">{company.lei}</dd></>}
          <dt>Country of incorporation</dt><dd>{countryName(company.country)}</dd>
          <dt>Registered address</dt><dd>{company.address ?? 'none'}</dd>
          <dt>Company domain</dt><dd className="mono">{company.domain ?? 'none'}</dd>
          <dt>First Owner</dt><dd>{first ? who(first) : 'none'}</dd>
          <dt>First Owner passkey (hash)</dt><dd className="mono">{first?.credentialHash ?? 'none'}</dd>
          <dt>Other people</dt><dd>{view.people.length ? view.people.map((p) => `${who(p)}, ${ROLE[p.role]}, ${p.email}`).join('; ') : 'none'}</dd>
          <dt>Recovery wallet</dt><dd className="mono">{wallet ? wallet.address : 'none'}</dd>
          <dt>Chain</dt><dd>{wallet?.chain ?? 'none'}</dd>
        </dl>
        <p>The undersigned declares that the details above are those of the company, that each person named above acts for the company in the Ophis Business console, in the role shown, and that the undersigned may bind the company.</p>
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
  if (!view) return problem ? <div className="stack"><Problem>{problem}</Problem></div> : null
  const { company, first, review, missing } = view
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
            <p>{company.legalName}{company.businessType ? `, ${BUSINESS[company.businessType] ?? company.businessType}` : company.kind ? `, ${KIND[company.kind] ?? company.kind}` : ''}{company.country ? `, incorporated in ${countryName(company.country)}` : ''}{company.registration ? `, number ${company.registration}` : ''}{company.lei ? `, LEI ${company.lei}` : ''}.</p>
            {company.address && <p>Registered address: {company.address}.</p>}
            <p>{!company.domain ? 'Created by Ophis for this local build, without an application.' : company.domainVerifiedAt ? `Domain ${company.domain}, proved by its DNS record on ${day(company.domainVerifiedAt)}.` : `Domain ${company.domain}, not proved by DNS: Ophis checks the company in its review.`}</p>
            {view.people.length > 0 && <p>{verified ? 'Approved by Ophis with the organisation' : 'Other people named in the application'}: {view.people.map((p) => `${who(p)} (${ROLE[p.role]}, ${p.email})`).join('; ')}. {verified
              ? 'Each has a seat under Organisation, Members and roles. An Owner or Admin gives each one a link there, then confirms the new passkey. No second person is needed.'
              : 'Ophis checks them with the company. When Ophis approves, each gets a seat. Do not invite them yourself.'}</p>}
          </Step>
          <Step icon="key-round" title="Passkeys" done={keys}>
            <p>{keys ? 'The first Owner holds two passkeys.' : 'The first Owner needs two passkeys, for example this computer and a phone. Add the second one now: until then this seat can do nothing else.'}</p>
            {!keys && <p><a className="btn ghost sm" href="/#/organisation">Open Organisation, My passkeys</a></p>}
          </Step>
          <Step icon="wallet" title="Recovery wallet or second Owner" done={proved}>
            {view.wallet ? <p>{view.wallet.label}: {kindOf(view.wallet)}, <span className="mono">{view.wallet.address}</span> on {view.wallet.chain}. {view.wallet.inForce ? 'It is the recovery wallet in force.' : 'It signed the activation. It becomes the recovery wallet when Ophis approves the organisation.'}</p>
              : <p>{proved ? 'A second Owner with two passkeys is enrolled. No recovery wallet is named.' : 'Name the wallet that restores access if every Owner is locked out, and let it sign once. Or invite a second Owner, who needs two passkeys.'}</p>}
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
                <p className="fine"><Icon name="info" size={16} /><span>Give the link to the people who hold the wallet, by a channel they trust. A Safe signs inside the Safe interface: add the signing page as a custom app and paste the link.</span></p>
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
              : review.status === 'under_review' ? `Under review since ${minute(review.since!)}. Ophis compares the company, the domain, the passkey hash and the recovery wallet.`
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
