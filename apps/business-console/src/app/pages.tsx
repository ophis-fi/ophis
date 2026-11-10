// The screens of milestone 1, with the markup and classes of the approved mockup.
import { useCallback, useEffect, useState } from 'react'
import { api, capital, Icon, ROLE, Section, stamp, Status, Tile } from './ui.tsx'

export interface Me {
  organisation: { id: string; name: string; kind: string }
  seat: { id: string; displayName: string; role: string }
  session: { id: string; endsAt: number }
}

const passkeysWork = () => typeof PublicKeyCredential !== 'undefined' && 'parseRequestOptionsFromJSON' in PublicKeyCredential
const NO_PASSKEYS = 'This browser cannot use passkeys. Use a current version of Chrome, Edge, Firefox or Safari.'
const Problem = ({ children }: { children: string }) => <p className="note bad" role="alert"><Icon name="triangle-alert" /><span className="grow">{children}</span></p>

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

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(passkeysWork() ? '' : NO_PASSKEYS)

  async function signIn() {
    setBusy(true)
    setProblem('')
    try {
      const start = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>('/api/signin/start', {})
      if (start.status !== 200) return setProblem('Sign-in is not available right now. Try again in a moment.')
      const passkey = (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(start.data.options) })) as PublicKeyCredential
      const finish = await api('/api/signin/finish', { response: passkey.toJSON() })
      // One message for every refusal: the server does not say why, and neither do we.
      if (finish.status !== 200) return setProblem('Sign-in did not work. Use a passkey that is active for your organisation.')
      onSignedIn()
    } catch {
      setProblem('The passkey request was cancelled or timed out. Try again.')
    } finally {
      setBusy(false)
    }
  }

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

interface Invitation { organisation: string; member: string; role: string; deviceBound: boolean; options: PublicKeyCredentialCreationOptionsJSON }

export function Enrol({ ticket }: { ticket: string }) {
  const [invitation, setInvitation] = useState<Invitation | null>()
  const [label, setLabel] = useState('Security key 1')
  const [busy, setBusy] = useState(false)
  const [stored, setStored] = useState(false)
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
      const finish = await api<{ error?: string }>('/api/enrol/finish', { ticket, label, response: passkey.toJSON() })
      if (finish.status === 200) return setStored(true)
      setProblem(
        finish.data.error === 'device_bound_required' ? 'This role needs a hardware security key. A passkey that syncs to a cloud account is not accepted.'
        : finish.data.error === 'label_invalid' ? 'Give the key a short name: letters, digits and spaces, 40 characters at most.'
        : 'The passkey was not stored. Ask for a new enrolment link.',
      )
    } catch {
      setProblem('The passkey request was cancelled or timed out. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="signin">
      <div>
        <span className="cap eyebrow rise">Enrolment</span>
        <h1 className="h-hero rise d1">Create <em>your passkey</em>.</h1>
        {invitation === undefined ? <p className="lede">Checking your enrolment link.</p>
        : invitation === null ? (
          <>
            <p className="lede rise d2">This enrolment link cannot be used. It works once and for a short time.</p>
            <div className="methods"><Problem>Ask the person who invited you for a new link.</Problem></div>
          </>
        ) : stored ? (
          <>
            <p className="lede rise d2">Your passkey is stored. It cannot sign in until it is confirmed.</p>
            <div className="methods">
              <p className="note ok" role="status"><Icon name="circle-check" /><span className="grow"><b>Passkey stored, waiting for confirmation.</b> Once it is confirmed, sign in from your bookmark.</span></p>
              <p className="fine"><Icon name="info" size={16} />Local build: confirm it with the activate command, then sign in.</p>
              <a className="btn ghost" href="#/"><Icon name="fingerprint" />Go to sign-in</a>
            </div>
          </>
        ) : (
          <>
            <p className="lede rise d2">You are joining <b>{invitation.organisation}</b> on <b>{location.host}</b>. Check both before you continue.</p>
            <div className="methods rise d3">
              <dl className="kv">
                <dt>Member</dt><dd>{invitation.member}</dd>
                <dt>Role</dt><dd>{ROLE[invitation.role] ?? invitation.role}</dd>
                <dt>Key type</dt><dd>{invitation.deviceBound ? 'Hardware security key, bound to the device' : 'Any passkey'}</dd>
              </dl>
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
          <div><span className="cap">Now</span><ul>
            <li><Icon name="check" size={16} />Touch your security key</li>
            <li><Icon name="check" size={16} />The passkey is stored as pending</li>
          </ul></div>
          <div><span className="cap">Until it is confirmed</span><ul className="x">
            <li><Icon name="x" size={16} />It cannot sign in</li>
            <li><Icon name="x" size={16} />This link cannot be used again</li>
          </ul></div>
        </div>
      </aside>
    </section>
  )
}

interface View {
  members: { id: string; displayName: string; role: string; state: string }[]
  passkeys: { seatId: string; label: string; state: string; deviceBound: boolean; createdAt: number; lastUsedAt: number | null }[]
  sessions: { id: string; seatId: string; createdAt: number; lastSeenAt: number; userAgent: string | null; country: string | null }[]
  currentSessionId: string
}
function browser(userAgent: string | null) {
  const name = userAgent?.match(/Edg|Firefox|Chrome|Safari/)?.[0].replace('Edg', 'Edge')
  const system = userAgent?.match(/Windows|Mac OS X|Android|iPhone|iPad|Linux/)?.[0].replace('Mac OS X', 'macOS')
  return name ? `${name}${system ? ` on ${system}` : ''}` : 'Unknown browser'
}

export function Organisation({ onSignedOut }: { onSignedOut: () => void }) {
  const [view, setView] = useState<View>()
  const [problem, setProblem] = useState('')
  const load = useCallback(async () => {
    const result = await api<View>('/api/org')
    if (result.status === 401) return onSignedOut()
    if (result.status !== 200) return setProblem('The organisation could not be loaded. Reload the page.')
    setView(result.data)
  }, [onSignedOut])
  useEffect(() => void load(), [load])

  async function revoke(id: string) {
    const result = await api(`/api/sessions/${id}/revoke`, {})
    if (result.status !== 200 && result.status !== 401) setProblem('The session could not be ended. Try again.')
    await load() // ending your own session answers 401 here, and the app returns to sign-in
  }
  const name = (seatId: string) => view?.members.find((member) => member.id === seatId)?.displayName ?? 'Member'

  return (
    <>
      <header className="ph"><div>
        <span className="cap eyebrow">Organisation</span>
        <h1 className="h-page">People, wallets and <em>two-person approval</em>.</h1>
        <p className="lede">Members, their passkeys and their sessions. Wallets and approvals arrive in later milestones.</p>
      </div></header>
      {problem && <Problem>{problem}</Problem>}

      <Section icon="user" title="Members and roles">
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Member</th><th>Role</th><th>Passkeys</th><th>Active sessions</th><th>Status</th></tr></thead>
          <tbody>{view?.members.map((member) => {
            const keys = view.passkeys.filter((key) => key.seatId === member.id)
            return (
              <tr key={member.id}>
                <td>{member.displayName}</td>
                <td>{ROLE[member.role] ?? member.role}</td>
                <td>{keys.length ? `${keys.length}: ${keys.map((key) => key.label).join(', ')}` : 'None'}</td>
                <td>{view.sessions.filter((session) => session.seatId === member.id).length || 'None'}</td>
                <td><Status>{capital(member.state)}</Status></td>
              </tr>
            )
          })}</tbody>
        </table></div>
      </Section>

      <Section icon="key-round" title="Passkeys" hint="Public keys only. A new passkey stays pending until it is confirmed. Owners use hardware keys.">
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Passkey</th><th>Member</th><th>Type</th><th>Added (UTC)</th><th>Last used (UTC)</th><th>Status</th></tr></thead>
          <tbody>{view?.passkeys.map((key, index) => (
            <tr key={index}>
              <td>{key.label}</td>
              <td>{name(key.seatId)}</td>
              <td>{key.deviceBound ? 'Bound to the device' : 'Synced'}</td>
              <td>{stamp(key.createdAt)}</td>
              <td>{key.lastUsedAt ? stamp(key.lastUsedAt) : 'Never'}</td>
              <td><Status>{capital(key.state)}</Status></td>
            </tr>
          ))}</tbody>
        </table></div>
      </Section>

      <Section icon="clock" title="Sessions" hint="A session locks after 15 minutes idle and ends after 12 hours. Ending one takes effect on its next request.">
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Member</th><th>Browser</th><th>Signed in (UTC)</th><th>Last active (UTC)</th><th><span className="sr">End the session</span></th></tr></thead>
          <tbody>{view?.sessions.map((session) => (
            <tr key={session.id}>
              <td>{name(session.seatId)}{session.id === view.currentSessionId && <small><Status>This session</Status></small>}</td>
              <td>{browser(session.userAgent)}{session.country && <small>{session.country}</small>}</td>
              <td>{stamp(session.createdAt)}</td>
              <td>{stamp(session.lastSeenAt)}</td>
              <td><button className="btn ghost sm" type="button" onClick={() => revoke(session.id)}><Icon name="log-out" size={16} />Revoke</button></td>
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
