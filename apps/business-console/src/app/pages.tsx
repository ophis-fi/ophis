// The screens of milestones 1 to 3, with the markup and classes of the approved mockup.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, CANCELLED, capital, Icon, minute, passkeyCheck, ROLE, say, Section, sensitive, stamp, Status, Tile } from './ui.tsx'

export interface Alert { key: string; kind: string; at?: number | null; until?: number; name?: string; by?: string | null; stopped?: boolean; what?: string; detail?: string | null; mine?: boolean }
export interface Me {
  organisation: { id: string; name: string; kind: string }
  seat: { id: string; displayName: string; role: string; keys: number; quarantineUntil: number | null }
  session: { id: string; endsAt: number; stepUpUntil: number }
  alerts: Alert[]
}

const passkeysWork = () => typeof PublicKeyCredential !== 'undefined' && 'parseRequestOptionsFromJSON' in PublicKeyCredential
const NO_PASSKEYS = 'This browser cannot use passkeys. Use a current version of Chrome, Edge, Firefox or Safari.'
const KEY_ROLES = ['owner', 'admin', 'approver', 'compliance']
export const Problem = ({ children }: { children: string }) => <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{children}</span></p>

function Trust() {
  return (
    <aside className="panel trust rise d2" aria-label="What signing in does">
      <Tile name="shield-check" />
      <h2>Signing in <em>never moves funds</em>.</h2>
      <p className="muted">Sign-in tells us who you are. Trades are signed by your own wallet or custodian.</p>
      <div className="cancan">
        <div><span className="cap">A session can</span><ul>
          <li><Icon name="check" size={16} />Read reports and statements</li>
          <li><Icon name="check" size={16} />Prepare an order for review</li>
          <li><Icon name="check" size={16} />Invite members, if you are Owner or Admin</li>
        </ul></div>
        <div><span className="cap">A session cannot</span><ul className="x">
          <li><Icon name="x" size={16} />Move funds</li>
          <li><Icon name="x" size={16} />Sign a trade</li>
          <li><Icon name="x" size={16} />Change a receiver address alone</li>
        </ul></div>
      </div>
    </aside>
  )
}

// Where a replaced passkey lands. It opens no session. Until quarantine ends it can do one thing.
function Replaced({ until, onBack }: { until: number; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [problem, setProblem] = useState('')

  async function stop() {
    setBusy(true)
    setProblem('')
    try {
      const result = await passkeyCheck('/api/stop/start', '/api/stop/finish')
      if (result.status === 200) return setStopped(true)
      setProblem('The replacement was not stopped. Use the replaced passkey itself, before the time above.')
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="signin">
      <div>
        <span className="cap eyebrow rise">Replaced passkey</span>
        <h1 className="h-hero rise d1">This passkey <em>was replaced</em>.</h1>
        {stopped ? (
          <>
            <p className="lede">The replacement is stopped.</p>
            <div className="methods">
              <p className="note ok" role="status"><Icon name="circle-check" /><span className="grow"><b>Replacement stopped.</b> The new passkey is revoked and your previous passkeys are valid again. Your seat is frozen until two people unfreeze it: an Owner or Admin asks, a second member with a key role approves. Call an Owner now.</span></p>
              <button className="btn ghost" type="button" onClick={onBack}><Icon name="fingerprint" />Back to sign-in</button>
            </div>
          </>
        ) : (
          <>
            <p className="lede rise d2">A colleague confirmed a new passkey for your seat, so this one no longer signs in. Until <b>{minute(until)}</b> it can do one thing.</p>
            <div className="methods rise d3">
              <button className="btn primary" type="button" onClick={stop} disabled={busy}><Icon name="ban" />Stop this replacement</button>
              {problem && <Problem>{problem}</Problem>}
              <p className="fine"><Icon name="info" size={16} />Stop it if you did not ask for a new passkey. If you did ask, do nothing: sign in with the new one.</p>
              <button className="btn ghost" type="button" onClick={onBack}><Icon name="fingerprint" />Back to sign-in</button>
            </div>
          </>
        )}
      </div>
      <aside className="panel trust rise d2" aria-label="What stopping does">
        <Tile name="shield" />
        <h2>One right, <em>for a short time</em>.</h2>
        <p className="muted">A replaced passkey is kept for 24 hours, or 72 hours for Owners, Admins, Approvers and Compliance officers. It cannot open a session.</p>
        <div className="cancan">
          <div><span className="cap">Stopping does</span><ul>
            <li><Icon name="check" size={16} />Revoke the new passkey</li>
            <li><Icon name="check" size={16} />Make your previous passkeys valid again</li>
            <li><Icon name="check" size={16} />Freeze the seat and tell every member</li>
          </ul></div>
          <div><span className="cap">Stopping does not</span><ul className="x">
            <li><Icon name="x" size={16} />Sign you in</li>
            <li><Icon name="x" size={16} />Unfreeze the seat: two colleagues do</li>
          </ul></div>
        </div>
      </aside>
    </section>
  )
}

// Where a passkey of a frozen seat lands. It opens no session, and nothing can be done from here.
interface FrozenInfo { by: string | null; at: number | null; stopped: boolean }
function Frozen({ info, onBack }: { info: FrozenInfo; onBack: () => void }) {
  const when = info.at ? ` on ${minute(info.at)}` : ''
  return (
    <section className="signin">
      <div>
        <span className="cap eyebrow rise">Frozen seat</span>
        <h1 className="h-hero rise d1">Your seat <em>is frozen</em>.</h1>
        <p className="lede rise d2">{info.stopped ? `A replaced passkey of this seat stopped its replacement${when}. That froze the seat.` : `${info.by ?? 'A colleague'} froze this seat${when}.`}</p>
        <div className="methods rise d3">
          <p className="note warn" role="status"><Icon name="ban" /><span className="grow"><b>This passkey opens no session until the seat is unfrozen.</b> Call an Owner or Admin of your organisation. One of them asks to unfreeze the seat, and a second member with a key role approves.</span></p>
          <button className="btn ghost" type="button" onClick={onBack}><Icon name="fingerprint" />Back to sign-in</button>
        </div>
      </div>
      <aside className="panel trust rise d2" aria-label="What a freeze does">
        <Tile name="shield" />
        <h2>Frozen, <em>not deleted</em>.</h2>
        <p className="muted">One Owner or Admin can freeze a seat at once when something looks wrong. Undoing it takes two people.</p>
        <div className="cancan">
          <div><span className="cap">While frozen</span><ul className="x">
            <li><Icon name="x" size={16} />No sign-in, no session</li>
            <li><Icon name="x" size={16} />No new passkey for this seat</li>
          </ul></div>
          <div><span className="cap">After the unfreeze</span><ul>
            <li><Icon name="check" size={16} />The passkeys that were active before the freeze work again</li>
            <li><Icon name="check" size={16} />You are told at sign-in</li>
          </ul></div>
        </div>
      </aside>
    </section>
  )
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false)
  const [replacedUntil, setReplacedUntil] = useState(0)
  const [frozen, setFrozen] = useState<FrozenInfo>()
  const [problem, setProblem] = useState(passkeysWork() ? '' : NO_PASSKEYS)

  async function signIn() {
    setBusy(true)
    setProblem('')
    try {
      const finish = await passkeyCheck<{ error?: string; until?: number } & FrozenInfo>('/api/signin/start', '/api/signin/finish')
      if (finish.status === 200) return onSignedIn()
      if (finish.status === 403 && finish.data.error === 'passkey_replaced') return setReplacedUntil(finish.data.until ?? 0)
      if (finish.status === 403 && finish.data.error === 'seat_frozen') return setFrozen(finish.data)
      // One message for every other refusal: the server does not say why, and neither do we.
      setProblem(finish.status === 401 ? 'Sign-in did not work. Use a passkey that is active for your organisation.' : 'Sign-in is not available right now. Try again in a moment.')
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }

  if (replacedUntil) return <Replaced until={replacedUntil} onBack={() => setReplacedUntil(0)} />
  if (frozen) return <Frozen info={frozen} onBack={() => setFrozen(undefined)} />
  return (
    <section className="signin">
      <div>
        <span className="cap eyebrow rise">Ophis Business</span>
        <h1 className="h-hero rise d1">Sign in to <em>your organisation</em>.</h1>
        <p className="lede rise d2">Use the passkey on your device or security key. No passwords. No SMS codes.</p>
        <div className="methods rise d3">
          <button className="btn primary" type="button" onClick={signIn} disabled={busy || !passkeysWork()}><Icon name="fingerprint" />Sign in with a passkey</button>
          {problem && <Problem>{problem}</Problem>}
          <p className="fine"><Icon name="info" size={16} />No username is asked. Your passkey tells us which organisation and seat you hold.</p>
          <p className="fine"><Icon name="building-2" size={16} /><span>New organisation? Access is by application, after business verification.</span></p>
        </div>
      </div>
      <Trust />
    </section>
  )
}

interface Invitation { organisation: string; member: string; role: string; deviceBound: boolean; first: boolean; options: PublicKeyCredentialCreationOptionsJSON }

export function Enrol({ ticket }: { ticket: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>()
  const [label, setLabel] = useState('Security key 1')
  const [busy, setBusy] = useState(false)
  const [stored, setStored] = useState<{ phrase: string[]; confirmBy: number }>()
  const [problem, setProblem] = useState(passkeysWork() ? '' : NO_PASSKEYS)

  useEffect(() => {
    if (!ticket) return setInvitation(null)
    api<Invitation>('/api/enrol/start', { ticket }).then((start) => setInvitation(start.status === 200 ? start.data : null))
  }, [ticket])

  async function create() {
    if (!invitation) return
    setBusy(true)
    setProblem('')
    try {
      // A fresh challenge for each attempt: the first one may have aged while the page was open.
      const start = await api<Invitation>('/api/enrol/start', { ticket })
      if (start.status !== 200) return setInvitation(null)
      const passkey = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(start.data.options) })) as PublicKeyCredential
      const finish = await api<{ error?: string; phrase: string[]; confirmBy: number }>('/api/enrol/finish', { ticket, label, response: passkey.toJSON() })
      if (finish.status === 200) return setStored(finish.data)
      setProblem(finish.data.error === 'not_stored' ? 'The passkey was not stored. Ask for a new enrolment link.' : say(finish.data))
    } catch {
      setProblem('The passkey request was cancelled, timed out, or this security key already holds a passkey for this seat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const facts = invitation && (
    <dl className="kv">
      <dt>Site</dt><dd className="site">{location.host}</dd>
      <dt>Organisation</dt><dd>{invitation.organisation}</dd>
      <dt>Member</dt><dd>{invitation.member}</dd>
      <dt>Role</dt><dd>{ROLE[invitation.role] ?? invitation.role}</dd>
      <dt>Key type</dt><dd>{invitation.deviceBound ? 'Hardware security key, bound to the device' : 'Any passkey'}</dd>
    </dl>
  )
  return (
    <section className="signin">
      <div>
        <span className="cap eyebrow rise">Enrolment</span>
        {invitation === undefined ? <><h1 className="h-hero">Create <em>your passkey</em>.</h1><p className="lede">Checking your enrolment link.</p></>
        : invitation === null ? (
          <>
            <h1 className="h-hero rise d1">Create <em>your passkey</em>.</h1>
            <p className="lede rise d2">This enrolment link cannot be used. It works once and for a short time.</p>
            <div className="methods"><Problem>Ask the person who invited you for a new link.</Problem></div>
          </>
        ) : stored ? (
          <>
            <h1 className="h-hero">Read these <em>three words</em> aloud.</h1>
            <p className="phrase" aria-label="Your three words">{stored.phrase.map((word, index) => <span key={index}>{word}</span>)}</p>
            <div className="methods wide">
              <p className="note warn" role="status"><Icon name="triangle-alert" /><span className="grow"><b>Read these words aloud to the colleague who invited you, face to face or on a call. Never type them or send them by message, email or chat.</b></span></p>
              {facts}
              <p className="fine"><Icon name="clock" size={16} />Your passkey is stored and cannot sign in yet. Your colleague types the words before {minute(stored.confirmBy)}. Next time, sign in from your bookmark.</p>
              {invitation.first && <p className="fine"><Icon name="info" size={16} />Local build, first Owner: confirm with the activate command, then sign in.</p>}
              <a className="btn ghost" href="#/"><Icon name="fingerprint" />Go to sign-in</a>
            </div>
          </>
        ) : (
          <>
            <h1 className="h-hero rise d1">Create <em>your passkey</em>.</h1>
            <p className="lede rise d2">You are joining <b>{invitation.organisation}</b> on <b>{location.host}</b>. Check both before you continue.</p>
            <div className="methods rise d3">
              {facts}
              <label className="field">Name for this key (no personal data)
                <input className="input" value={label} maxLength={40} autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
              </label>
              <button className="btn primary" type="button" onClick={create} disabled={busy || !passkeysWork()}><Icon name="key-round" />Create passkey</button>
              {problem && <Problem>{problem}</Problem>}
            </div>
          </>
        )}
      </div>
      <aside className="panel trust rise d2" aria-label="How enrolment works">
        <Tile name="key-round" />
        <h2>A new passkey <em>waits for confirmation</em>.</h2>
        <p className="muted">Your key stays on your device. We store its public half only. No email, phone call or typed code can add a passkey or reset one.</p>
        <div className="cancan">
          <div><span className="cap">You</span><ul>
            <li><Icon name="check" size={16} />Touch your security key</li>
            <li><Icon name="check" size={16} />Read three words aloud to your colleague</li>
          </ul></div>
          <div><span className="cap">Until they type them</span><ul className="x">
            <li><Icon name="x" size={16} />The passkey cannot sign in</li>
            <li><Icon name="x" size={16} />This link cannot be used again</li>
          </ul></div>
        </div>
      </aside>
    </section>
  )
}

interface Member { id: string; displayName: string; role: string; state: string }
interface Passkey { id: string; seatId: string; label: string; state: string; deviceBound: boolean; createdAt: number; lastUsedAt: number | null; stopRightUntil: number | null }
interface Ticket { id: string; kind: string; role: string; seatId: string; name: string; issuerSeatId: string | null; status: 'link' | 'issuer' | 'second' | 'wait'; myStep: 'issuer' | 'second' | null; until: number }
interface Request { id: string; kind: string; subjectId: string; name: string | null; role: string | null; value: string | null; requester: string; requesterRole: string; createdAt: number; expiresAt: number; notBefore: number | null; mine: boolean }
interface Wallet { id: string; chainId: number; address: string; kind: string; label: string; state: 'pending' | 'linked'; recovery: 'in_force' | 'waiting' | null; recoveryAt: number | null; threshold?: number; owners?: number }
interface View {
  wallets: Wallet[]
  chains: { id: number; name: string }[]
  approvals: Request[]
  frozen: ({ id: string } & FrozenInfo)[]
  syncedKeysAllowed: boolean
  rights: { can: string; roles: string[]; fresh: boolean; second: boolean }[]
  members: Member[]
  passkeys: Passkey[]
  sessions: { id: string; seatId: string; createdAt: number; lastSeenAt: number; userAgent: string | null; country: string | null }[]
  tickets: Ticket[]
  currentSessionId: string
}
type Result = { status: number; data: { error?: string; left?: number } }
function browser(userAgent: string | null) {
  const name = userAgent?.match(/Edg|Firefox|Chrome|Safari/)?.[0].replace('Edg', 'Edge')
  const system = userAgent?.match(/Windows|Mac OS X|Android|iPhone|iPad|Linux/)?.[0].replace('Mac OS X', 'macOS')
  return name ? `${name}${system ? ` on ${system}` : ''}` : 'Unknown browser'
}

// Invite a member or re-enrol one, in two steps: who, then the link to hand over. The link exists in this
// dialog only: the server keeps its hash, and closing the dialog forgets it.
function TicketDialog({ seat, mayOwner, onClose }: { seat: Member | null; mayOwner: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState('viewer')
  const [issued, setIssued] = useState<{ link: string; role: string; expiresAt: number }>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])

  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    try {
      const result = await sensitive<{ link: string; role: string; expiresAt: number }>('/api/tickets', seat ? { seatId: seat.id } : { displayName: name, role })
      if (result.status === 200) setIssued(result.data)
      else setProblem(result.status === 401 ? 'Your session has ended. Sign in again.' : say(result.data))
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }
  const reEnrol = seat?.state === 'active'
  const keyRole = KEY_ROLES.includes(issued?.role ?? seat?.role ?? role)
  const title = reEnrol ? 'Re-enrol a member' : 'Invite a member'

  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="tk-h" onClose={onClose}>
      <header className="dh"><Tile name={reEnrol ? 'history' : 'user'} /><div className="grow"><h2 className="h-panel" id="tk-h">{title}</h2><span className="cap">Step {issued ? 2 : 1} of 2</span></div>
        <button className="ib" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="x" /></button></header>
      <div className="db">
        <ol className="steps">
          <li aria-current={issued ? undefined : 'step'}><Tile name="user" /><h3 className="h-card">Who</h3>{issued && <Status>Done</Status>}
            <form className="body" onSubmit={create}>
              {seat ? (
                <>
                  <dl className="kv"><dt>Member</dt><dd>{seat.displayName}</dd><dt>Role</dt><dd>{ROLE[seat.role] ?? seat.role}</dd></dl>
                  {reEnrol && <p>For a member who lost every passkey. Once the new passkey is confirmed, their previous passkeys are suspended and their sessions end. For {keyRole ? 72 : 24} hours a previous passkey can still stop the replacement.</p>}
                </>
              ) : (
                <>
                  <label className="field">Name shown to colleagues
                    <input className="input" value={name} maxLength={60} required autoComplete="off" disabled={Boolean(issued)} onChange={(event) => setName(event.target.value)} />
                  </label>
                  <label className="field">Role
                    <select className="input" value={role} disabled={Boolean(issued)} onChange={(event) => setRole(event.target.value)}>
                      {Object.entries(ROLE).filter(([value]) => mayOwner || value !== 'owner').map(([value, text]) => <option key={value} value={value}>{text}</option>)}
                    </select>
                  </label>
                </>
              )}
              {!issued && <button className="btn primary md" type="submit" disabled={busy}><Icon name="key-round" size={16} />Create the link</button>}
              {problem && <Problem>{problem}</Problem>}
            </form>
          </li>
          <li aria-current={issued ? 'step' : undefined}><Tile name="arrow-left-right" /><h3 className="h-card">Hand over the link</h3>
            <div className="body">
              {issued ? (
                <>
                  <p className="note warn"><Icon name="clock" /><span className="grow"><b>This link works once, until {minute(issued.expiresAt)}.</b> {keyRole ? 'Hand it over in person or inside a live call. Never by email.' : 'Send it to the member only.'}</span></p>
                  <label className="field">Enrolment link
                    <input className="input mono" readOnly value={issued.link} onFocus={(event) => event.target.select()} />
                  </label>
                  <button className="btn ghost md" type="button" onClick={() => navigator.clipboard.writeText(issued.link).then(() => setCopied(true), () => setCopied(false))}><Icon name="clipboard-check" size={16} />{copied ? 'Copied' : 'Copy the link'}</button>
                  <p>The member opens it, creates a passkey and reads you three words. Type them under <b>Waiting for confirmation</b>{keyRole ? '. A second person with a key role types them too' : ''}. This screen never shows the words.</p>
                </>
              ) : <p>The link appears here. {keyRole ? 'For this role it works for 10 minutes.' : 'For this role it works for 24 hours.'}</p>}
            </div>
          </li>
        </ol>
      </div>
      <footer className="df"><button className="btn primary md" type="button" onClick={() => dialog.current?.close()}>{issued ? 'Done' : 'Cancel'}</button></footer>
    </dialog>
  )
}

// One open ticket: what it waits for, and the three-word input when it waits for this member.
function Waiting({ ticket, issuer, mayCancel, act }: { ticket: Ticket; issuer: string; mayCancel: boolean; act: Act }) {
  const [words, setWords] = useState('')
  const path = `/api/tickets/${ticket.id}`
  const text =
    ticket.status === 'link' ? `Waiting for ${ticket.name} to open the link and create a passkey. The link works until ${minute(ticket.until)}.`
    : ticket.myStep === 'issuer' ? `${ticket.name} has created a passkey. Type the three words they read to you, before ${minute(ticket.until)}.`
    : ticket.myStep === 'second' ? `${issuer} typed the words. You are the second person: type the three words ${ticket.name} reads to you, before ${minute(ticket.until)}.`
    : ticket.status === 'issuer' ? `Waiting for ${issuer} to type the three words.`
    : ticket.status === 'second' ? `${issuer} typed the words. Waiting for a second person with a key role, other than ${issuer} and ${ticket.name}, before ${minute(ticket.until)}. No wait replaces that person here.`
    : `This organisation has had no other member with a key role in the last 30 days, so a 72 hour wait stands in for the second person. The passkey becomes active at its first sign-in after ${minute(ticket.until)}. Any Owner can cancel until then.`
  function confirm(event: FormEvent) {
    event.preventDefault()
    void act(() => passkeyCheck<Result['data']>(`${path}/confirm/start`, `${path}/confirm`, { words })).then(() => setWords(''))
  }
  return (
    <article className="appr">
      <Tile name={ticket.myStep ? 'users' : 'clock'} />
      <div>
        <h3 className="h-card">{ticket.name}<small>{ROLE[ticket.role] ?? ticket.role}, {ticket.kind === 're_enrolment' ? 're-enrolment' : 'invitation'}</small></h3>
        <p>{text}</p>
      </div>
      {mayCancel && <button className="btn ghost sm" type="button" onClick={() => act(() => sensitive(`${path}/cancel`))}><Icon name="x" size={16} />Cancel</button>}
      {ticket.myStep && (
        <form className="words" onSubmit={confirm}>
          <label className="field">Three words heard from {ticket.name}
            <input className="input" value={words} required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="word word word" onChange={(event) => setWords(event.target.value)} />
          </label>
          <button className="btn primary md" type="submit"><Icon name="fingerprint" size={16} />Confirm with passkey</button>
          <p className="fine"><Icon name="info" size={16} />Type the words only if you heard them from this person, face to face or on a call you placed yourself. Never accept them by email or chat.</p>
        </form>
      )}
    </article>
  )
}

// What a change does, in plain words. Shown before the click that asks for it and before the click that approves it.
const role = (code: string | null | undefined) => ROLE[code ?? ''] ?? code ?? ''
function effect(kind: string, name: string, was: string | null, value?: string | null) {
  return kind === 'seat.freeze' ? `Freezes the seat of ${name} (${role(was)}) at once. Their passkeys are suspended, not deleted, and their sessions end. Links they issued and changes they asked for are cancelled. Every member is told. Unfreezing takes two people.`
    : kind === 'seat.unfreeze' ? `Unfreezes the seat of ${name} (${role(was)}). The passkeys that were active before the freeze work again and they can sign in.`
    : kind === 'seat.remove' ? `Removes ${name} (${role(was)}) from the organisation. Their passkeys are revoked, their sessions end, and their open links and requests are cancelled. This cannot be undone: coming back takes a new invitation.`
    : kind === 'seat.role' ? `Changes the role of ${name} from ${role(was)} to ${role(value)}. Their sessions end, and the new role starts at their next sign-in.`
    : value === '1' ? 'Allows passkeys that sync to a cloud account for Admins, Approvers and Compliance officers. Owners still need hardware keys. This lowers a security setting.'
    : 'Requires hardware security keys again for Admins, Approvers and Compliance officers. Passkeys already enrolled stay.'
}
const CHANGE: Record<string, string> = {
  'seat.unfreeze': 'Unfreeze a seat', 'seat.remove': 'Remove a member', 'seat.role': 'Change a role', 'policy.synced_keys': 'Change the passkey rule for key roles',
  'wallet.link': 'Link a wallet', 'anchor.set': 'Set the recovery wallet',
}
// The same for a wallet. `on` is the chain's name.
const kindOf = (w: Wallet) => (w.kind === 'safe' ? `Safe ${w.threshold ?? '?'} of ${w.owners ?? '?'}` : w.kind === 'custodian' ? 'Custodian wallet' : 'Single key')
function walletEffect(kind: string, w: Wallet, on: string) {
  const which = `${w.label} (${w.address} on ${on}, ${kindOf(w)})`
  return kind === 'wallet.link' ? `Links the wallet ${which} to the organisation. The wallet signed a message that names this organisation, and the server checked the signature. Every member sees linked wallets.`
    : kind === 'anchor.set' ? `Makes ${which} the recovery wallet: if every Owner is locked out, only this wallet can restore access. It is in force 72 hours after the approval. Until then the one in force stays, and any Owner can cancel the change.`
    : kind === 'anchor.cancel' ? `Cancels the change. ${w.label} does not become the recovery wallet, and the one in force stays. Done at once, by you alone.`
    : `Unlinks ${w.label} from the organisation. The wallet itself is not touched. Linking it again takes a new signature. Done at once, by you alone.`
}
type Act = (action: () => Promise<Result>) => Promise<void>

// One request that waits for its second person: what will change, who asked, and the buttons this member may use.
function Approval({ request, wallet, on, mayDecide, act }: { request: Request; wallet?: Wallet; on: string; mayDecide: boolean; act: Act }) {
  const [open, setOpen] = useState(false)
  const path = `/api/approvals/${request.id}`
  const early = (request.notBefore ?? 0) > Date.now()
  const what = wallet ? walletEffect(request.kind, wallet, on) : effect(request.kind, request.name ?? '', request.role, request.value)
  return (
    <article className="appr">
      <Tile name={wallet ? 'wallet' : request.kind === 'policy.synced_keys' ? 'key-round' : 'user'} />
      <div>
        <h3 className="h-card">{CHANGE[request.kind] ?? 'A change'}</h3>
        <p>{what}</p>
        <p className="fine">Requested by {request.mine ? 'you' : `${request.requester} (${role(request.requesterRole)})`} on {stamp(request.createdAt)}. One of two approvals.{early && ` Can be approved from ${minute(request.notBefore!)}.`}</p>
        {open && (
          <dl className="kv">
            <dt>Change</dt><dd>{CHANGE[request.kind]}</dd>
            {request.name && <><dt>Member</dt><dd>{request.name}</dd></>}
            {wallet && <><dt>Wallet</dt><dd>{wallet.label}</dd><dt>Address</dt><dd className="mono">{wallet.address}</dd><dt>Chain</dt><dd>{on}</dd><dt>Kind</dt><dd>{kindOf(wallet)}</dd></>}
            {request.kind === 'seat.role' && <><dt>Role now</dt><dd>{role(request.role)}</dd><dt>Role after</dt><dd>{role(request.value)}</dd></>}
            <dt>Requested by</dt><dd>{request.requester} ({role(request.requesterRole)})</dd>
            <dt>Second person</dt><dd>Any Owner, Admin, Approver or Compliance officer other than the requester, after a passkey check</dd>
            <dt>Applied</dt><dd>{request.kind === 'anchor.set' ? 'In force 72 hours after the approval' : `At the moment of the approval${early ? `, not before ${minute(request.notBefore!)}` : ''}`}</dd>
            <dt>Expires</dt><dd>{minute(request.expiresAt)}</dd>
          </dl>
        )}
      </div>
      <div className="acts">
        <button className="btn ghost md" type="button" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="eye" size={16} />Review</button>
        {request.mine ? <button className="btn ghost md" type="button" onClick={() => act(() => api(`${path}/cancel`, {}))}><Icon name="x" size={16} />Cancel request</button>
        : mayDecide && (
          <>
            <button className="btn ghost md" type="button" onClick={() => act(() => sensitive(`${path}/reject`))}><Icon name="x" size={16} />Reject</button>
            <button className="btn primary md" type="button" disabled={early} onClick={() => act(() => sensitive(`${path}/approve`))}><Icon name="check" size={16} />Approve</button>
          </>
        )}
      </div>
    </article>
  )
}

// What an Owner or Admin can do with one seat. Every choice says what it does before its button.
function ManageDialog({ seat, frozen, mayOwner, act, onClose }: { seat: Member; frozen?: FrozenInfo; mayOwner: boolean; act: Act; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const roles = Object.keys(ROLE).filter((code) => code !== seat.role && (mayOwner || code !== 'owner'))
  const [to, setTo] = useState(roles[0])
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])
  const run = (what: string, body: unknown = {}) => {
    dialog.current?.close()
    void act(() => sensitive(`/api/members/${seat.id}/${what}`, body))
  }
  const two = 'It needs a second person: the request waits under Approvals for 7 days.'
  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="mg-h" onClose={onClose}>
      <header className="dh"><Tile name="settings" /><div className="grow"><h2 className="h-panel" id="mg-h">Manage {seat.displayName}</h2><span className="cap">{role(seat.role)}, {seat.state}</span></div>
        <button className="ib" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="x" /></button></header>
      <div className="db">
        <ul className="choices">
          {seat.state === 'active' && (
            <li><Tile name="ban" /><h3 className="h-card">Freeze seat</h3>
              <div className="body"><p>{effect('seat.freeze', seat.displayName, seat.role)}</p>
                <button className="btn primary md" type="button" onClick={() => run('freeze')}><Icon name="ban" size={16} />Freeze seat now</button></div></li>
          )}
          {seat.state === 'frozen' && (
            <li><Tile name="circle-check" /><h3 className="h-card">Request unfreeze</h3>
              <div className="body"><p>{frozen && (frozen.stopped ? 'A replaced passkey of this seat stopped its replacement' : `Frozen by ${frozen.by ?? 'a colleague'}`)}{frozen?.at ? ` on ${minute(frozen.at)}. ` : ''}{effect('seat.unfreeze', seat.displayName, seat.role)} {two}</p>
                <button className="btn primary md" type="button" onClick={() => run('unfreeze')}><Icon name="users" size={16} />Request unfreeze</button></div></li>
          )}
          {seat.state === 'active' && (
            <li><Tile name="users" /><h3 className="h-card">Request role change</h3>
              <div className="body">
                <label className="field">New role
                  <select className="input" value={to} onChange={(event) => setTo(event.target.value)}>{roles.map((code) => <option key={code} value={code}>{ROLE[code]}</option>)}</select>
                </label>
                <p>{effect('seat.role', seat.displayName, seat.role, to)} {two}</p>
                <button className="btn primary md" type="button" onClick={() => run('role', { role: to })}><Icon name="users" size={16} />Request role change</button></div></li>
          )}
          {seat.state === 'invited' ? (
            <li><Tile name="x" /><h3 className="h-card">Remove invitation</h3>
              <div className="body"><p>Removes the invited seat of {seat.displayName} and cancels its link. Nobody enrolled on it, so this is done at once, by you alone.</p>
                <button className="btn primary md" type="button" onClick={() => run('remove')}><Icon name="x" size={16} />Remove invitation now</button></div></li>
          ) : (
            <li><Tile name="x" /><h3 className="h-card">Request removal</h3>
              <div className="body"><p>{effect('seat.remove', seat.displayName, seat.role)} {two}</p>
                <button className="btn primary md" type="button" onClick={() => run('remove')}><Icon name="users" size={16} />Request removal</button></div></li>
          )}
        </ul>
      </div>
      <footer className="df"><button className="btn ghost md" type="button" onClick={() => dialog.current?.close()}>Close</button></footer>
    </dialog>
  )
}

// Step 1: which wallet. Step 2: the signing link, for the people who hold the wallet. Nothing is stored before the wallet signs.
function LinkDialog({ chains, onClose }: { chains: View['chains']; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [label, setLabel] = useState('Treasury')
  const [address, setAddress] = useState('')
  const [chainId, setChainId] = useState(chains[0]?.id ?? 1)
  const [custodian, setCustodian] = useState(false)
  const [issued, setIssued] = useState<{ link: string; expiresAt: number }>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setProblem('')
    try {
      const result = await sensitive<{ link: string; expiresAt: number }>('/api/wallets/intent', { chainId, address: address.trim(), label: label.trim(), custodian })
      if (result.status === 200) setIssued(result.data)
      else setProblem(result.status === 401 ? 'Your session has ended. Sign in again.' : say(result.data))
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="lk-h" onClose={onClose}>
      <header className="dh"><Tile name="wallet" /><div className="grow"><h2 className="h-panel" id="lk-h">Link a wallet</h2><span className="cap">Step {issued ? 2 : 1} of 2</span></div>
        <button className="ib" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="x" /></button></header>
      <div className="db">
        <ol className="steps">
          <li aria-current={issued ? undefined : 'step'}><Tile name="wallet" /><h3 className="h-card">Which wallet</h3>{issued && <Status>Done</Status>}
            {!issued && (
              <form className="body" onSubmit={create}>
                <label className="field">Name in the console
                  <input className="input" value={label} maxLength={40} required onChange={(event) => setLabel(event.target.value)} />
                </label>
                <label className="field">Address
                  <input className="input mono" value={address} required spellCheck={false} autoComplete="off" placeholder="0x" onChange={(event) => setAddress(event.target.value)} />
                </label>
                <label className="field">Chain
                  <select className="input" value={chainId} onChange={(event) => setChainId(Number(event.target.value))}>{chains.map((chain) => <option key={chain.id} value={chain.id}>{chain.name}</option>)}</select>
                </label>
                <label className="check"><input type="checkbox" checked={custodian} onChange={(event) => setCustodian(event.target.checked)} /><span>A custodian holds this wallet (Fireblocks, Ledger Enterprise or similar)</span></label>
                {problem && <Problem>{problem}</Problem>}
                <p>This creates a signing link and stores nothing. The wallet is linked once it has signed a message that names this organisation. With colleagues in key roles, one of them then approves the link under Approvals.</p>
                <button className="btn primary md" type="submit" disabled={busy}><Icon name="wallet" size={16} />Create the signing link</button>
              </form>
            )}
          </li>
          <li aria-current={issued ? 'step' : undefined}><Tile name="arrow-left-right" /><h3 className="h-card">Hand over the signing link</h3>
            <div className="body">
              {issued ? (
                <>
                  <p className="note warn"><Icon name="clock" /><span className="grow"><b>This link works once, until {minute(issued.expiresAt)}.</b> It moves no funds. Give it to the people who hold the wallet.</span></p>
                  <label className="field">Signing link
                    <input className="input mono" readOnly value={issued.link} onFocus={(event) => event.target.select()} />
                  </label>
                  <button className="btn ghost md" type="button" onClick={() => navigator.clipboard.writeText(issued.link).then(() => setCopied(true), () => setCopied(false))}><Icon name="clipboard-check" size={16} />{copied ? 'Copied' : 'Copy the link'}</button>
                  <p><b>A wallet in a browser, or a custodian's browser extension:</b> open the link in that browser. <b>A Safe:</b> in the Safe interface open Apps, add <span className="mono">{issued.link.split('#')[0]}</span> as a custom app, open it and paste the link. The page shows what will be signed, on its own address, and holds no session of this console.</p>
                </>
              ) : <p>The link appears here. It works for 7 days.</p>}
            </div>
          </li>
        </ol>
      </div>
      <footer className="df"><button className="btn primary md" type="button" onClick={() => dialog.current?.close()}>{issued ? 'Done' : 'Cancel'}</button></footer>
    </dialog>
  )
}

// What this member may do with one wallet. Each choice says what it does before its button.
function WalletDialog({ wallet, on, may, act, onClose }: { wallet: Wallet; on: string; may: { unlink: boolean; set: boolean; cancel: boolean }; act: Act; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal()
  }, [])
  const run = (what: string) => {
    dialog.current?.close()
    void act(() => sensitive(`/api/wallets/${wallet.id}/${what}`))
  }
  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="wl-h" onClose={onClose}>
      <header className="dh"><Tile name="wallet" /><div className="grow"><h2 className="h-panel" id="wl-h">Manage {wallet.label}</h2><span className="cap">{kindOf(wallet)}, {on}</span></div>
        <button className="ib" type="button" aria-label="Close" onClick={() => dialog.current?.close()}><Icon name="x" /></button></header>
      <div className="db">
        <ul className="choices">
          {may.set && (
            <li><Tile name="shield-check" /><h3 className="h-card">Set as recovery wallet</h3>
              <div className="body"><p>{walletEffect('anchor.set', wallet, on)} With colleagues in key roles it needs a second person: the request waits under Approvals for 7 days.</p>
                <button className="btn primary md" type="button" onClick={() => run('anchor')}><Icon name="users" size={16} />Request recovery wallet</button></div></li>
          )}
          {may.cancel && (
            <li><Tile name="x" /><h3 className="h-card">Cancel change</h3>
              <div className="body"><p>{walletEffect('anchor.cancel', wallet, on)}</p>
                <button className="btn primary md" type="button" onClick={() => run('anchor/cancel')}><Icon name="x" size={16} />Cancel the change now</button></div></li>
          )}
          <li><Tile name="x" /><h3 className="h-card">Unlink</h3>
            <div className="body">{wallet.recovery ? <p>This is the recovery wallet{wallet.recovery === 'waiting' ? ', waiting for its 72 hours' : ''}. It cannot be unlinked. Two people replace it first.</p>
              : !may.unlink ? <p>An Owner or Admin with two passkeys unlinks a wallet.</p>
              : <p>{walletEffect('wallet.unlink', wallet, on)}</p>}
              <button className="btn primary md" type="button" disabled={Boolean(wallet.recovery) || !may.unlink} onClick={() => run('unlink')}><Icon name="x" size={16} />Unlink now</button></div></li>
        </ul>
      </div>
      <footer className="df"><button className="btn ghost md" type="button" onClick={() => dialog.current?.close()}>Close</button></footer>
    </dialog>
  )
}

export function Organisation({ me, onSignedOut, onChanged }: { me: Me; onSignedOut: () => void; onChanged: () => void }) {
  const [view, setView] = useState<View>()
  const [problem, setProblem] = useState('')
  const [ticketFor, setTicketFor] = useState<Member | null>() // undefined: closed. null: a new member. A member: a new link for that seat.
  const [managed, setManaged] = useState<Member>()
  const [linking, setLinking] = useState(false)
  const [walletId, setWalletId] = useState<string>()
  const [copiedId, setCopiedId] = useState('')
  const [label, setLabel] = useState('Security key 2')
  const load = useCallback(async () => {
    const result = await api<View>('/api/org')
    if (result.status === 401) return onSignedOut()
    if (result.status !== 200) return setProblem('The organisation could not be loaded. Reload the page.')
    setView(result.data)
  }, [onSignedOut])
  useEffect(() => void load(), [load])

  // Every action goes through here: run it, say what went wrong, then show the new state.
  const act: Act = async (action) => {
    setProblem('')
    try {
      const result = await action()
      if (result.status !== 200 && result.status !== 401) setProblem(say(result.data))
    } catch {
      setProblem(CANCELLED)
    }
    await load() // a 401 here returns the app to sign-in: ending your own session, or revoking its passkey
    onChanged()
  }
  async function addPasskey(event: FormEvent) {
    event.preventDefault()
    await act(async () => {
      const start = await sensitive<{ options: PublicKeyCredentialCreationOptionsJSON }>('/api/passkeys/start')
      if (start.status !== 200) return start
      const passkey = (await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(start.data.options) })) as PublicKeyCredential
      return api<Result['data']>('/api/passkeys/finish', { label, response: passkey.toJSON() })
    })
  }

  const name = (seatId: string | null) => view?.members.find((member) => member.id === seatId)?.displayName ?? 'A colleague'
  const manages = me.seat.role === 'owner' || me.seat.role === 'admin'
  const ready = me.seat.keys >= 2
  const quarantined = (me.seat.quarantineUntil ?? 0) > Date.now()
  const mayManage = (role: string) => me.seat.role === 'owner' || (me.seat.role === 'admin' && role !== 'owner')
  const hardware = me.seat.role === 'owner'
  const chain = (id: number) => view?.chains.find((c) => c.id === id)?.name ?? `Chain ${id}`
  const wallet = view?.wallets.find((w) => w.id === walletId)
  const last = (key: Passkey) => view?.passkeys.filter((other) => other.seatId === key.seatId && other.state === 'active').length === 1
  const keyRows = (keys: Passkey[], own: boolean) => keys.map((key) => (
    <tr key={key.id}>
      <td>{key.label}</td>
      {!own && <td>{name(key.seatId)}</td>}
      <td>{key.deviceBound ? 'Bound to the device' : 'Synced'}</td>
      <td>{stamp(key.createdAt)}</td>
      <td>{key.lastUsedAt ? stamp(key.lastUsedAt) : 'Never'}</td>
      <td><Status>{capital(key.state)}</Status>{key.state === 'suspended' && key.stopRightUntil && <small>Can stop its replacement until {minute(key.stopRightUntil)}</small>}</td>
      <td>{key.state === 'active' && ready && !last(key) && (own || (!quarantined && view?.members.some((member) => member.id === key.seatId && member.state === 'active' && mayManage(member.role)))) && (
        <button className="btn ghost sm" type="button" aria-label={`Revoke ${key.label}${own ? '' : ` of ${name(key.seatId)}`}`} title="The passkey stops working at once. The seat keeps its other passkey." onClick={() => act(() => sensitive(`/api/passkeys/${key.id}/revoke`))}><Icon name="x" size={16} />Revoke</button>
      )}</td>
    </tr>
  ))
  const keyHead = (own: boolean) => <thead><tr><th>Passkey</th>{!own && <th>Member</th>}<th>Type</th><th>Added (UTC)</th><th>Last used (UTC)</th><th>Status</th><th><span className="sr">Revoke the passkey</span></th></tr></thead>

  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Organisation</span>
        <h1 className="h-page">People, wallets and <em>two-person approval</em>.</h1>
        <p className="lede">Members, their passkeys and sessions, linked wallets, and the changes that need a second person.</p>
      </div></header>
      <div className="stack">
        {!ready && <p className="note warn" role="status"><Icon name="key-round" /><span className="grow"><b>Add your second {hardware ? 'hardware key' : 'passkey'}.</b> A seat needs two before it can invite, confirm or revoke. Use <a href="#my-passkeys">My passkeys</a> below.</span></p>}
        {quarantined && <p className="note warn" role="status"><Icon name="clock" /><span className="grow"><b>Your seat is in quarantine until {minute(me.seat.quarantineUntil!)}.</b> It was re-enrolled. Until then it cannot add a member or revoke a colleague's passkey, and a replaced passkey can still stop the replacement.</span></p>}
        {problem && <Problem>{problem}</Problem>}
      </div>

      {view && view.tickets.length > 0 && (
        <Section icon="users" title="Waiting for confirmation" hint="A new passkey works only after a colleague types the three words its owner reads out. Key roles need a second person.">
          <div className="stack">{view.tickets.map((ticket) => <Waiting key={ticket.id} ticket={ticket} issuer={ticket.issuerSeatId === me.seat.id ? 'You' : name(ticket.issuerSeatId)} mayCancel={me.seat.role === 'owner' && ready} act={act} />)}</div>
        </Section>
      )}

      {view && (
        <Section id="approvals" icon="users" title="Approvals" hint="Approving asks for your passkey. The requester cannot approve.">
          <div className="stack">
            {view.approvals.map((request) => {
              const about = view.wallets.find((w) => w.id === request.subjectId)
              return <Approval key={request.id} request={request} wallet={about} on={about ? chain(about.chainId) : ''} mayDecide={KEY_ROLES.includes(me.seat.role) && ready && !quarantined} act={act} />
            })}
            {view.approvals.length === 0 && <p className="note ok"><Icon name="circle-check" /><span className="grow"><b>Nothing waits.</b> A request to unfreeze a seat, remove a member, change a role, change the passkey rule, link a wallet or set the recovery wallet appears here, and in the audit log.</span></p>}
          </div>
        </Section>
      )}

      <Section icon="user" title="Members and roles" action={manages && ready && !quarantined && <button className="btn ghost sm" type="button" onClick={() => setTicketFor(null)}><Icon name="user" size={16} />Invite member</button>}>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Member</th><th>Role</th><th>Passkeys</th><th>Active sessions</th><th>Status</th>{manages && <th><span className="sr">Enrolment and changes</span></th>}</tr></thead>
          <tbody>{view?.members.map((member) => {
            const keys = view.passkeys.filter((key) => key.seatId === member.id && key.state === 'active')
            const again = manages && ready && member.id !== me.seat.id && mayManage(member.role) && (member.state === 'active' || (member.state === 'invited' && !quarantined))
            const frozen = view.frozen.find((seat) => seat.id === member.id)
            return (
              <tr key={member.id}>
                <td>{member.displayName}</td>
                <td>{ROLE[member.role] ?? member.role}</td>
                <td>{keys.length ? `${keys.length}: ${keys.map((key) => key.label).join(', ')}` : 'None'}</td>
                <td>{view.sessions.filter((session) => session.seatId === member.id).length || 'None'}</td>
                <td><Status>{capital(member.state)}</Status>{frozen && <small>{frozen.stopped ? 'A replaced passkey stopped its replacement' : `By ${frozen.by ?? 'a colleague'}`}{frozen.at ? ` on ${minute(frozen.at)}` : ''}</small>}</td>
                {manages && <td><div className="acts">
                  {again && <button className="btn ghost sm" type="button" aria-label={`${member.state === 'active' ? 'Re-enrol' : 'New link for'} ${member.displayName}`} onClick={() => setTicketFor(member)}><Icon name="history" size={16} />{member.state === 'active' ? 'Re-enrol' : 'New link'}</button>}
                  {ready && !quarantined && mayManage(member.role) && member.state !== 'removed' && <button className="btn ghost sm" type="button" aria-label={`Manage ${member.displayName}`} onClick={() => setManaged(member)}><Icon name="settings" size={16} />Manage</button>}
                </div></td>}
              </tr>
            )
          })}</tbody>
        </table></div>
      </Section>
      {managed && <ManageDialog seat={managed} frozen={view?.frozen.find((seat) => seat.id === managed.id)} mayOwner={me.seat.role === 'owner'} act={act} onClose={() => setManaged(undefined)} />}
      {ticketFor !== undefined && <TicketDialog seat={ticketFor} mayOwner={me.seat.role === 'owner'} onClose={() => { setTicketFor(undefined); void load() }} />}

      <Section id="wallets" icon="wallet" title="Wallets" hint="A wallet is linked by its own signature. One linked wallet is the recovery wallet: if every Owner is locked out, only it can restore access."
        action={manages && ready && !quarantined && <button className="btn ghost sm" type="button" onClick={() => setLinking(true)}><Icon name="wallet" size={16} />Link a wallet</button>}>
        {view && view.wallets.length === 0 ? <p className="note"><Icon name="info" /><span className="grow"><b>No wallet is linked.</b> {manages ? 'Use "Link a wallet": the console gives a signing link, and the wallet signs on a separate page.' : 'An Owner or Admin links one.'}</span></p> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Wallet</th><th>Chain</th><th>Kind</th><th>Status</th><th><span className="sr">Changes</span></th></tr></thead>
            <tbody>{view?.wallets.map((w) => (
              <tr key={w.id}>
                <td>{w.label}<small><span className="mono">{w.address}</span> <button className="ib" type="button" aria-label={`Copy the address of ${w.label}`} title={copiedId === w.id ? 'Copied' : 'Copy the address'} onClick={() => navigator.clipboard.writeText(w.address).then(() => setCopiedId(w.id), () => setCopiedId(''))}><Icon name={copiedId === w.id ? 'check' : 'clipboard-check'} size={16} /></button></small></td>
                <td>{chain(w.chainId)}</td>
                <td>{kindOf(w)}</td>
                <td className="wrap"><Status>{w.state === 'linked' ? 'Linked' : 'Pending'}</Status>{w.state === 'pending' && <small>Waits for a second person, under Approvals</small>}
                  {w.recovery && <><span className={`badge bi ${w.recovery === 'in_force' ? 'ok' : 'warn'}`}><Icon name={w.recovery === 'in_force' ? 'shield-check' : 'clock'} size={16} />Recovery wallet</span>
                    <small>{w.recovery === 'in_force' ? `In force since ${minute(w.recoveryAt!)}` : `In force from ${minute(w.recoveryAt!)}. Until then an Owner can cancel.`}</small></>}</td>
                <td>{w.state === 'linked' && manages && <button className="btn ghost sm" type="button" aria-label={`Manage ${w.label}`} onClick={() => setWalletId(w.id)}><Icon name="settings" size={16} />Manage</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Section>
      {linking && view && <LinkDialog chains={view.chains} onClose={() => { setLinking(false); void load() }} />}
      {wallet && <WalletDialog wallet={wallet} on={chain(wallet.chainId)} act={act} onClose={() => setWalletId(undefined)}
        may={{ unlink: ready, set: hardware && ready && !quarantined && !wallet.recovery && !view!.wallets.some((w) => w.recovery === 'waiting'), cancel: hardware && ready && wallet.recovery === 'waiting' }} />}

      <Section id="my-passkeys" icon="key-round" title="My passkeys" hint={`Public keys only. Keep two${hardware ? ' hardware keys' : ''}: if you lose one, sign in with the other, revoke the lost one and add a new one.`}>
        <div className="table-wrap"><table className="t">{keyHead(true)}<tbody>{view && keyRows(view.passkeys.filter((key) => key.seatId === me.seat.id), true)}</tbody></table></div>
        <form className="addkey" onSubmit={addPasskey}>
          <label className="field">Name for the new key (no personal data)
            <input className="input" value={label} maxLength={40} required autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
          </label>
          <button className="btn primary md" type="submit" disabled={!passkeysWork()}><Icon name="key-round" size={16} />Add a passkey</button>
          <p className="fine"><Icon name="info" size={16} />Asks for a passkey you already hold, then for the new one{hardware ? ', which must be a second hardware key' : ''}. Your other sessions end.</p>
        </form>
      </Section>

      {manages && (
        <Section icon="key-square" title="Passkeys of colleagues" hint="A new passkey stays pending until it is confirmed. A replaced passkey is suspended, not deleted: it can stop its replacement. A member's last passkey is never revoked: re-enrol the member to replace lost passkeys, or freeze the seat in an emergency.">
          <div className="table-wrap"><table className="t">{keyHead(false)}<tbody>{view && keyRows(view.passkeys.filter((key) => key.seatId !== me.seat.id), false)}</tbody></table></div>
        </Section>
      )}

      <Section icon="clock" title="Sessions" hint="A session locks after 15 minutes idle and ends after 12 hours. Ending one takes effect on its next request.">
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Member</th><th>Browser</th><th>Signed in (UTC)</th><th>Last active (UTC)</th><th><span className="sr">End the session</span></th></tr></thead>
          <tbody>{view?.sessions.map((session) => (
            <tr key={session.id}>
              <td>{name(session.seatId)}{session.id === view.currentSessionId && <small><Status>This session</Status></small>}</td>
              <td>{browser(session.userAgent)}{session.country && <small>{session.country}</small>}</td>
              <td>{stamp(session.createdAt)}</td>
              <td>{stamp(session.lastSeenAt)}</td>
              <td><button className="btn ghost sm" type="button" onClick={() => act(() => api(`/api/sessions/${session.id}/revoke`, {}))}><Icon name="log-out" size={16} />End session</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </Section>

      {view && (
        <Section icon="key-square" title="Passkey rule for key roles" hint="Owners always need hardware security keys. This rule is for Admins, Approvers and Compliance officers.">
          <article className="appr">
            <Tile name="key-round" />
            <div>
              <h3 className="h-card">{view.syncedKeysAllowed ? 'Synced passkeys are allowed' : 'Hardware security keys only'}</h3>
              <p>An Owner can ask to change it. {effect('policy.synced_keys', '', null, view.syncedKeysAllowed ? '0' : '1')} {view.syncedKeysAllowed ? 'It needs a second person.' : 'It needs a second person, who can approve 24 hours after the request at the earliest.'}</p>
            </div>
            {me.seat.role === 'owner' && ready && !quarantined && <button className="btn ghost sm" type="button" onClick={() => act(() => sensitive('/api/policy', { syncedKeys: !view.syncedKeysAllowed }))}><Icon name="users" size={16} />{view.syncedKeysAllowed ? 'Request hardware keys only' : 'Request to allow synced passkeys'}</button>}
          </article>
        </Section>
      )}

      {view && (
        <Section icon="list-checks" title="What each role can do" hint="No role can sign a trade. Signatures come from the wallet. This table is read from the rules the server enforces.">
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Action</th>{Object.values(ROLE).map((text) => <th key={text}>{text}</th>)}<th>Passkey check first</th><th>Second person</th></tr></thead>
            <tbody>{view.rights.map((right) => (
              <tr key={right.can}>
                <td className="wrap">{right.can}</td>
                {Object.keys(ROLE).map((code) => <td key={code}>{right.roles.includes(code) ? <span className="yes"><Icon name="check" size={16} /><span className="sr">Yes</span></span> : <span className="no"><Icon name="minus" size={16} /><span className="sr">No</span></span>}</td>)}
                <td>{right.fresh ? 'Yes' : 'No'}</td>
                <td>{right.second ? 'Yes' : 'No'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Section>
      )}
      <Section later icon="key-round" title="API keys" hint="Read-only keys for reports come after the first release. No key will be able to move funds." />
    </>
  )
}

// What a member must read at sign-in, since no email is sent. The page behind stays closed until they confirm.
const ALERT: Record<string, (alert: Alert) => string> = {
  new_passkey: (a) => `A passkey was added to your seat on ${minute(a.at!)}. If that was not you, tell an Owner now and revoke it under My passkeys.`,
  re_enrolment_started: (a) => `A re-enrolment of your seat was started on ${minute(a.at!)}. Signing in with a passkey you already hold closes it. If you did not ask for it, tell an Owner.`,
  re_enrolment_completed: (a) => `Your seat was re-enrolled on ${minute(a.at!)}: a new passkey replaced the previous ones.`,
  quarantine: (a) => `Your seat is in quarantine until ${minute(a.until!)}. It cannot add a member or revoke a colleague's passkey, and a replaced passkey can still stop the replacement.`,
  colleague_re_enrolled: (a) => `${a.name} was re-enrolled on ${minute(a.at!)}: a new passkey replaced their previous ones. If that surprises you, call them.`,
  colleague_joined: (a) => `${a.name} joined on a link issued on ${minute(a.at!)}: a colleague confirmed their first passkey. If you do not know this member, tell an Owner.`,
  re_enrolment_closed: (a) => `${a.name} signed in on ${minute(a.at!)} with a passkey they still hold, while a re-enrolment of their seat was open. It was closed. If you started it, the request may not have come from ${a.name}: call them.`,
  seat_frozen: (a) => `The seat of ${a.name} is frozen: ${a.stopped ? 'a replaced passkey stopped its replacement' : `${a.by ?? 'a colleague'} froze it`}${a.at ? ` on ${minute(a.at)}` : ''}. It cannot sign in until two people unfreeze it: an Owner or Admin asks, a second member with a key role approves.`,
  approval_waiting: (a) => `${a.name} asked for a change that needs a second person. Review it under Approvals.`,
  changed: (a) => {
    const [from, to] = (a.detail ?? '').split('.')
    const when = `on ${minute(a.at!)}`
    return a.what === 'seat.role' ? `${a.mine ? 'Your role' : `The role of ${a.name}`} was changed ${when}, from ${role(from)} to ${role(to)}. Two people decided it.`
      : a.what === 'seat.remove' ? `${a.name} was removed from the organisation ${when}. Two people decided it.`
      : a.what === 'seat.unfreeze' ? `${a.mine ? 'Your seat' : `The seat of ${a.name}`} was unfrozen ${when}. Two people decided it.`
      : a.what === 'wallet.link' ? `The wallet ${a.name} was linked ${when}. ${a.detail === 'alone' ? 'The only key-role member did it alone.' : 'Two people decided it.'}`
      : a.what === 'anchor.set' ? `The wallet ${a.name} was ${a.detail === 'alone' ? 'set as the recovery wallet by the only key-role member' : 'approved as the recovery wallet'} ${when}. It is in force 72 hours later. Until then an Owner can cancel the change, under Wallets.`
      : `The passkey rule for key roles was changed ${when}: ${a.detail === 'synced' ? 'synced passkeys are allowed for Admins, Approvers and Compliance officers' : 'hardware security keys only'}. Two people decided it.`
  },
  confirmation_waiting: (a) => `A new passkey of ${a.name} waits for the three words from you, under Waiting for confirmation.`,
}
export function Alerts({ alerts, onRead }: { alerts: Alert[]; onRead: () => void }) {
  return (
    <section className="panel alerts" role="alertdialog" aria-labelledby="al-h" aria-describedby="al-b">
      <Tile name="triangle-alert" />
      <h1 className="h-page" id="al-h">Read this <em>before you continue</em>.</h1>
      <ul id="al-b">{alerts.map((alert) => <li key={alert.key}><Icon name="info" size={16} />{ALERT[alert.kind]?.(alert) ?? 'Something changed on your seat. Ask an Owner.'}</li>)}</ul>
      <p className="fine"><Icon name="info" size={16} />Ophis sends no email about these events. They are shown here, when you sign in.</p>
      <div><button className="btn primary" type="button" autoFocus onClick={onRead}><Icon name="check" />I have read this</button></div>
    </section>
  )
}

interface AuditPage {
  rows: { seq: number; at: number; who: string; event: string; target: string; prevHash: string; hash: string }[]
  next: number | null
  chain: { ok: boolean; rows?: number; head?: string; seq?: number }
}
const short = (hash: string) => `${hash.slice(0, 10)}...${hash.slice(-4)}`
// Compliance: the audit log of the organisation. The server says whether the chain holds; the export carries every hash in full.
export function Compliance({ onSignedOut }: { onSignedOut: () => void }) {
  const [page, setPage] = useState<AuditPage>()
  const [cursors, setCursors] = useState<number[]>([]) // the pages gone through, newest first: the last one is shown
  const [problem, setProblem] = useState('')
  const before = cursors.at(-1)
  const load = useCallback(async () => {
    const result = await api<AuditPage>(`/api/audit${before ? `?before=${before}` : ''}`)
    if (result.status === 401) return onSignedOut()
    if (result.status === 200) return setPage(result.data)
    setProblem(result.status === 403 ? 'The audit log is open to Owners, Compliance officers and Viewers.' : 'The audit log could not be loaded. Reload the page.')
  }, [before, onSignedOut])
  useEffect(() => void load(), [load])

  async function exportCsv() {
    setProblem('')
    try {
      const out = await sensitive<{ name: string; csv: string }>('/api/audit/export')
      if (out.status === 401) return onSignedOut()
      if (out.status !== 200) return setProblem(say(out.data))
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob([out.data.csv], { type: 'text/csv' }))
      link.download = out.data.name
      link.click()
      URL.revokeObjectURL(link.href)
      await load() // the export is itself a row of the log
    } catch {
      setProblem(CANCELLED)
    }
  }

  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Compliance</span>
        <h1 className="h-page">Records and <em>the audit trail</em>.</h1>
        <p className="lede">Every change in your organisation, in the order it happened. All times UTC.</p>
      </div></header>
      {problem && <div className="stack"><Problem>{problem}</Problem></div>}
      {page && (
        <Section icon="scroll-text" title="Audit log" hint="Each row carries the hash of the row before it. A changed row breaks the chain."
          action={<button className="btn ghost sm" type="button" title="Asks for your passkey, writes a row in this log, then downloads every row with both hashes in full." onClick={exportCsv}><Icon name="download" size={16} />Export CSV</button>}>
          <p className="chain" role="status">
            <Status>{page.chain.ok ? 'Chain verified' : 'Chain broken'}</Status>
            {page.chain.ok ? `The server checked all ${page.chain.rows} rows just now. Newest row hash ${short(page.chain.head ?? '')}.` : `The chain does not hold at row ${page.chain.seq}. Keep your last export and tell Ophis.`}
          </p>
          <div className="table-wrap"><table className="t">
            <thead><tr><th className="num">No.</th><th>Time (UTC)</th><th>Who</th><th>Event</th><th>Target</th><th>Previous row hash</th><th>Row hash</th></tr></thead>
            <tbody>{page.rows.map((row) => (
              <tr key={row.seq}>
                <td className="num">{row.seq}</td>
                <td>{stamp(row.at)}</td>
                <td>{row.who}</td>
                <td className="wrap">{row.event}</td>
                <td>{row.target}</td>
                <td>{/^0+$/.test(row.prevHash) ? <span className="muted">First row</span> : <span className="mono muted" title={row.prevHash}>{short(row.prevHash)}</span>}</td>
                <td><span className="mono" title={row.hash}>{short(row.hash)}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="pager">
            <button className="btn ghost sm" type="button" disabled={!cursors.length} onClick={() => setCursors(cursors.slice(0, -1))}>Newer rows</button>
            <button className="btn ghost sm" type="button" disabled={!page.next} onClick={() => setCursors([...cursors, page.next!])}>Older rows</button>
          </div>
        </Section>
      )}
      <Section later icon="shield-check" title="Screening and the stored KYB record" hint="Screening results by linked wallet and the stored verification record arrive with onboarding." />
    </>
  )
}

// Rows of the approved mockup, from security-design.md section 6. true = in place today for the product that runs now.
// Every row about this console stays "Planned" until the console ships: a local build proves nothing to a client.
type Row = [icon: string, title: string, sentence: string, inPlace?: boolean]
const SECURITY: [group: string, icon: string, summary: string, rows: Row[]][] = [
  ['How you sign in', 'fingerprint', 'Passkeys first.', [
    ['fingerprint', 'Passkey sign-in', 'Sign-in uses passkeys, with no passwords and no SMS codes.'],
    ['shield-check', 'Stricter rule for key roles', 'Owners, admins, approvers and compliance officers sign in with passkeys only, with no fallback code.'],
    ['clock', 'Short sessions', 'A session locks after 15 minutes idle and ends after 12 hours.'],
  ]],
  ['If you lose access', 'shield', 'No weak reset.', [
    ['ban', 'No reset by email, phone or code', 'No email, phone call or typed code can reset access to an account.'],
    ['users', 'Colleagues confirm a new passkey', 'A lost passkey is replaced only after a colleague types three words read out by the member. Key roles need two colleagues.'],
    ['wallet', 'Your wallet is the last resort', 'If every Owner is locked out, only the recovery wallet of your organisation can restore access, after a 72-hour wait.'],
    ['clock', 'Time to object', 'For some days after a recovery the replaced passkey can still stop the new one, and sensitive changes are blocked.'],
  ]],
  ['What we store', 'database', 'Results and records.', [
    ['globe', 'Stored in the EU', 'The account database is restricted to the European Union and encrypted at rest.'],
    ['key-square', 'No decryption key in the cloud', 'Our servers and our cloud provider hold no key that can open sealed records.'],
    ['lock-keyhole', 'Sealed in your browser', 'Owner names, signatories, contact persons and signed declarations are encrypted in your browser before upload. Two offline hardware keys unlock them, and the key fingerprint is printed in your contract.'],
    ['eye', 'Readable by design', 'Member names, roles, linked wallets and company details are stored readable, because the service uses them on every request.'],
    ['clipboard-check', 'Results, not documents', 'We keep a verification result and a fingerprint of the evidence, not copies of identity documents.'],
    ['scroll-text', 'Tamper-evident audit log', 'Every action, including ours, is written to a hash-chained log that you can export.'],
    ['history', 'Backups', 'The account database can be restored to any minute of the last 7 days. A weekly copy, sealed with the same offline key, is kept outside the cloud provider.'],
  ]],
  ['Who can read it', 'eye', 'Your organisation first.', [
    ['building-2', 'Your data, kept apart', 'Every record belongs to one organisation, and each endpoint is tested against access from another.'],
    ['user', 'No impersonation', 'Ophis has no feature to sign in as you, and each access through our console appears in your log.'],
    ['users', 'Two-person approval', 'Changes to wallets, payout addresses, members, API keys and security settings need a second person.'],
    ['life-buoy', 'Support assistant', 'The assistant receives your question with emails, addresses and your organisation name removed, plus public help articles. An outside provider runs it in the United States. Ophis does not store the question text.'],
  ]],
  ['How we build it', 'list-checks', 'Checks on every change.', [
    ['list-checks', 'Checked code', 'Every pull request is scanned for known vulnerabilities and leaked secrets. New dependency versions wait 7 days, except reviewed security fixes.', true],
  ]],
  ['What we never hold', 'key-round', 'Your keys and your documents.', [
    ['key-round', 'Your keys stay with you', 'Ophis never holds your private keys. Every trade is signed by your own wallet or custodian.', true],
    ['eye', 'Check before you sign', 'Each order is shown decoded, with tokens, amounts, receiver and fees, before your wallet signs.'],
    ['ban', 'No passwords, no documents', 'The account system stores no passwords, no seed phrases, no SMS numbers for sign-in, no identity documents and no card or bank details.'],
  ]],
]

interface Ready { owners: { level: string; count: number }; wallet: { level: string; why: string | null; label: string | null; at: number | null; threshold?: number; owners?: number }; overall: string; step: string | null }
const OVERALL: Record<string, [badge: string, sentence: string]> = {
  ready: ['Ready', 'Access can be restored if a passkey, or an Owner, is lost.'],
  at_risk: ['At risk', 'Access can still be restored, with little margin.'],
  not_recoverable: ['Not recoverable', 'One Owner and no recovery wallet: if that Owner is locked out, nobody can restore access.'],
}
const STEP: Record<string, string> = {
  second_key: 'Next step: every Owner adds a second hardware key, under Organisation, My passkeys.',
  second_owner: 'Next step: invite a second Owner, who enrols two hardware keys.',
  recovery_wallet: 'Next step: link a wallet and set it as the recovery wallet, under Organisation, Wallets. A Safe with a threshold of 2 or more and no module is best.',
}
const WHY: Record<string, (w: Ready['wallet']) => string> = {
  waiting: (w) => `${w.label} is in force from ${minute(w.at!)}. Until then it does not count.`,
  single_key: (w) => `${w.label} is a single key: whoever holds that key restores access alone.`,
  custodian: (w) => `${w.label} is a custodian wallet: its approval rules cannot be checked from outside.`,
  module: (w) => `${w.label} is a Safe with a module enabled. A module can sign without the owners.`,
  threshold: (w) => `${w.label} is a Safe that one owner can sign for alone.`,
  changed: (w) => `The owners or the threshold of ${w.label} changed since it was approved. Check with its owners that the change was theirs.`,
  unreadable: (w) => `${w.label} could not be read on both network endpoints just now. Reload the page to try again.`,
}
const LEVEL: Record<string, string> = { green: 'Green', amber: 'Amber', red: 'Red', none: 'None' }
// For an Owner: how ready the organisation is to recover access. The server reads the recovery wallet on the chain for this page.
function Readiness() {
  const [ready, setReady] = useState<Ready>()
  useEffect(() => void api<Ready>('/api/readiness').then((result) => result.status === 200 && setReady(result.data)), [])
  if (!ready) return null
  const { owners, wallet } = ready
  const [badge, sentence] = OVERALL[ready.overall] ?? OVERALL.at_risk
  return (
    <section className="sg" id="readiness" aria-labelledby="rd-h">
      <header><Tile name="life-buoy" /><div><h2 className="h-panel" id="rd-h">Recovery readiness</h2><p><Status>{badge}</Status></p><p>{sentence} {ready.step && STEP[ready.step]}</p></div></header>
      <div>
        <div className="srow"><Icon name="users" size={20} /><b>Owners</b><Status>{LEVEL[owners.level]}</Status>
          <p>{owners.level === 'green' ? `${owners.count} Owners, each with two hardware keys.` : owners.level === 'amber' ? 'One Owner, with two hardware keys. If that person is locked out, only the recovery wallet restores access.' : 'An Owner holds fewer than two hardware keys. One lost key locks that Owner out.'}</p></div>
        <div className="srow"><Icon name="wallet" size={20} /><b>Recovery wallet</b><Status>{LEVEL[wallet.level]}</Status>
          <p>{wallet.level === 'none' ? 'No recovery wallet is set.' : wallet.level === 'green' ? `${wallet.label}: a Safe, ${wallet.threshold} of ${wallet.owners}, no module, owners unchanged since its approval. In force since ${minute(wallet.at!)}.` : WHY[wallet.why ?? '']?.(wallet)}</p></div>
      </div>
    </section>
  )
}

export function Security({ owner }: { owner: boolean }) {
  const rows = SECURITY.flatMap((group) => group[3])
  const inPlace = rows.filter((row) => row[3]).length
  const stats: [number, string, string, string][] = [
    [inPlace, 'circle-check', 'In place today', 'For the product that runs now'],
    [rows.length - inPlace, 'calendar', 'Planned', 'Ships with the business console'],
    [0, 'key-round', 'Client keys held by Ophis', 'Your wallet or custodian signs'],
  ]
  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Security and data</span>
        <h1 className="h-page">What we store, <em>and what we never hold</em>.</h1>
        <p className="lede">Each item below says whether it is in place today or planned.</p>
      </div></header>
      <div className="stats">{stats.map(([count, icon, caption, sub]) => (
        <div className="c" key={caption}><span className="num">{count}</span><span className="cap"><Icon name={icon} size={16} />{caption}</span><span className="sub">{sub}</span></div>
      ))}</div>
      <div className="groups">{owner && <Readiness />}{SECURITY.map(([group, icon, summary, groupRows]) => (
        <section className="sg" key={group}>
          <header><Tile name={icon} /><div><h2 className="h-panel">{group}</h2><p>{summary}</p></div></header>
          <div>{groupRows.map(([rowIcon, title, sentence, on]) => (
            <div className="srow" key={title}><Icon name={rowIcon} size={20} /><b>{title}</b><Status>{on ? 'In place today' : 'Planned'}</Status><p>{sentence}</p></div>
          ))}</div>
        </section>
      ))}</div>
      <div className="note"><Icon name="info" /><span className="grow"><b>Limits.</b> No hardware security module, no external certification of Ophis, one operator today. Only the database is pinned to the EU.</span></div>
    </>
  )
}
