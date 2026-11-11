// The screens of milestones 1 and 2, with the markup and classes of the approved mockup.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, CANCELLED, capital, Icon, minute, passkeyCheck, ROLE, say, Section, sensitive, stamp, Status, Tile } from './ui.tsx'

export interface Alert { key: string; kind: string; at?: number; until?: number; name?: string }
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
              <p className="note ok" role="status"><Icon name="circle-check" /><span className="grow"><b>Replacement stopped.</b> The new passkey is revoked and your previous passkeys are valid again. Your seat is frozen until an Owner and a second person decide which passkeys stand. Call an Owner now.</span></p>
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
            <li><Icon name="x" size={16} />Unfreeze the seat: an Owner and a second person do</li>
          </ul></div>
        </div>
      </aside>
    </section>
  )
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false)
  const [replacedUntil, setReplacedUntil] = useState(0)
  const [problem, setProblem] = useState(passkeysWork() ? '' : NO_PASSKEYS)

  async function signIn() {
    setBusy(true)
    setProblem('')
    try {
      const finish = await passkeyCheck<{ error?: string; until?: number }>('/api/signin/start', '/api/signin/finish')
      if (finish.status === 200) return onSignedIn()
      if (finish.status === 403 && finish.data.error === 'passkey_replaced') return setReplacedUntil(finish.data.until ?? 0)
      // One message for every other refusal: the server does not say why, and neither do we.
      setProblem(finish.status === 401 ? 'Sign-in did not work. Use a passkey that is active for your organisation.' : 'Sign-in is not available right now. Try again in a moment.')
    } catch {
      setProblem(CANCELLED)
    } finally {
      setBusy(false)
    }
  }

  if (replacedUntil) return <Replaced until={replacedUntil} onBack={() => setReplacedUntil(0)} />
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
interface View {
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
function Waiting({ ticket, issuer, mayCancel, act }: { ticket: Ticket; issuer: string; mayCancel: boolean; act: (action: () => Promise<Result>) => Promise<void> }) {
  const [words, setWords] = useState('')
  const path = `/api/tickets/${ticket.id}`
  const text =
    ticket.status === 'link' ? `Waiting for ${ticket.name} to open the link and create a passkey. The link works until ${minute(ticket.until)}.`
    : ticket.myStep === 'issuer' ? `${ticket.name} has created a passkey. Type the three words they read to you, before ${minute(ticket.until)}.`
    : ticket.myStep === 'second' ? `${issuer} typed the words. You are the second person: type the three words ${ticket.name} reads to you, before ${minute(ticket.until)}.`
    : ticket.status === 'issuer' ? `Waiting for ${issuer} to type the three words.`
    : ticket.status === 'second' ? `${issuer} typed the words. Waiting for a second person with a key role, other than ${issuer} and ${ticket.name}.`
    : `No second person exists. The passkey becomes active at its first sign-in after ${minute(ticket.until)}. Any Owner can cancel until then.`
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

export function Organisation({ me, onSignedOut, onChanged }: { me: Me; onSignedOut: () => void; onChanged: () => void }) {
  const [view, setView] = useState<View>()
  const [problem, setProblem] = useState('')
  const [ticketFor, setTicketFor] = useState<Member | null>() // undefined: closed. null: a new member. A member: a new link for that seat.
  const [label, setLabel] = useState('Security key 2')
  const load = useCallback(async () => {
    const result = await api<View>('/api/org')
    if (result.status === 401) return onSignedOut()
    if (result.status !== 200) return setProblem('The organisation could not be loaded. Reload the page.')
    setView(result.data)
  }, [onSignedOut])
  useEffect(() => void load(), [load])

  // Every action goes through here: run it, say what went wrong, then show the new state.
  async function act(action: () => Promise<Result>) {
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
  const last = (key: Passkey) => view?.passkeys.filter((other) => other.seatId === key.seatId && other.state === 'active').length === 1
  const keyRows = (keys: Passkey[], own: boolean) => keys.map((key) => (
    <tr key={key.id}>
      <td>{key.label}</td>
      {!own && <td>{name(key.seatId)}</td>}
      <td>{key.deviceBound ? 'Bound to the device' : 'Synced'}</td>
      <td>{stamp(key.createdAt)}</td>
      <td>{key.lastUsedAt ? stamp(key.lastUsedAt) : 'Never'}</td>
      <td><Status>{capital(key.state)}</Status>{key.state === 'suspended' && key.stopRightUntil && <small>Can stop its replacement until {minute(key.stopRightUntil)}</small>}</td>
      <td>{key.state === 'active' && ready && (own || (!quarantined && view?.members.some((member) => member.id === key.seatId && member.state === 'active' && mayManage(member.role)))) && (
        <button className="btn ghost sm" type="button" aria-label={`Revoke ${key.label}${own ? '' : ` of ${name(key.seatId)}${last(key) ? ' and freeze the seat' : ''}`}`} onClick={() => act(() => sensitive(`/api/passkeys/${key.id}/revoke`))}><Icon name={!own && last(key) ? 'ban' : 'x'} size={16} />{!own && last(key) ? 'Revoke and freeze seat' : 'Revoke'}</button>
      )}</td>
    </tr>
  ))
  const keyHead = (own: boolean) => <thead><tr><th>Passkey</th>{!own && <th>Member</th>}<th>Type</th><th>Added (UTC)</th><th>Last used (UTC)</th><th>Status</th><th><span className="sr">Revoke the passkey</span></th></tr></thead>

  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Organisation</span>
        <h1 className="h-page">People, wallets and <em>two-person approval</em>.</h1>
        <p className="lede">Members, their passkeys and their sessions. Wallets and approvals arrive in later milestones.</p>
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

      <Section icon="user" title="Members and roles" action={manages && ready && !quarantined && <button className="btn ghost sm" type="button" onClick={() => setTicketFor(null)}><Icon name="user" size={16} />Invite member</button>}>
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Member</th><th>Role</th><th>Passkeys</th><th>Active sessions</th><th>Status</th>{manages && <th><span className="sr">Enrolment</span></th>}</tr></thead>
          <tbody>{view?.members.map((member) => {
            const keys = view.passkeys.filter((key) => key.seatId === member.id && key.state === 'active')
            const again = manages && ready && member.id !== me.seat.id && mayManage(member.role) && (member.state === 'active' || (member.state === 'invited' && !quarantined))
            return (
              <tr key={member.id}>
                <td>{member.displayName}</td>
                <td>{ROLE[member.role] ?? member.role}</td>
                <td>{keys.length ? `${keys.length}: ${keys.map((key) => key.label).join(', ')}` : 'None'}</td>
                <td>{view.sessions.filter((session) => session.seatId === member.id).length || 'None'}</td>
                <td><Status>{capital(member.state)}</Status></td>
                {manages && <td>{again && <button className="btn ghost sm" type="button" aria-label={`${member.state === 'active' ? 'Re-enrol' : 'New link for'} ${member.displayName}`} onClick={() => setTicketFor(member)}><Icon name="history" size={16} />{member.state === 'active' ? 'Re-enrol' : 'New link'}</button>}</td>}
              </tr>
            )
          })}</tbody>
        </table></div>
      </Section>
      {ticketFor !== undefined && <TicketDialog seat={ticketFor} mayOwner={me.seat.role === 'owner'} onClose={() => { setTicketFor(undefined); void load() }} />}

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
        <Section icon="key-square" title="Passkeys of colleagues" hint="A new passkey stays pending until it is confirmed. A replaced passkey is suspended, not deleted: it can stop its replacement. Revoking a member's last passkey freezes their seat: to replace lost passkeys, re-enrol the member instead.">
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

      <Section later icon="users" title="Approvals" hint="Changes to wallets, members and security settings will need a second person. The requester cannot approve." />
      <Section later icon="wallet" title="Linked wallets and recovery wallet" hint="Ownership will be proved with a signed message. One wallet per organisation restores access if every Owner is locked out." />
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
  seat_frozen: (a) => `The seat of ${a.name} is frozen: a replaced passkey stopped its replacement, or a colleague revoked its last passkey. It cannot sign in until an Owner and a second person decide which passkeys stand.`,
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

export function Security() {
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
      <div className="groups">{SECURITY.map(([group, icon, summary, groupRows]) => (
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
