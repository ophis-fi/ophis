// App shell: band, bar, rail, footer line. Routes live in the URL fragment, as in the mockup.
import { StrictMode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './fonts.css'
import './kit.css'
import './app.css'
import mark from './assets/ophis-icon-mono-dark.svg'
import { Alerts, Closed, Compliance, Enrol, Organisation, Problem, Recover, RecoveryBanner, SignIn, type Me } from './pages.tsx'
import { api, Icon, ROLE } from './ui.tsx'
import { Desk, Overview } from './desk.tsx'
import { Support } from './support.tsx'
import { Apply, KybRecord, Onboarding } from './onboarding.tsx'
import { onPhone } from './phone.ts'

const onHashChange = (listener: () => void) => {
  addEventListener('hashchange', listener)
  return () => removeEventListener('hashchange', listener)
}
// The enrolment ticket arrives as #/enrol/<ticket>. It is taken out of the address bar and the history
// at once, and is only ever sent in a POST body.
function takeTicket() {
  const ticket = location.hash.match(/^#\/enrol\/([A-Za-z0-9_-]{43})$/)?.[1]
  if (ticket) history.replaceState(null, '', '#/enrol')
  return ticket
}
// Owner, 2026-11-18: the console is for computers (phone.ts; the server refuses the API too). A phone leaves the
// ticket in the address, so the link still works once opened on a computer (Codex, PR #1665).
const phone = onPhone()
const firstTicket = phone ? '' : takeTicket() ?? ''

// Alerts this browser has shown and the member has confirmed. Kept per browser on purpose: an alert read
// on someone else's device is still shown on the member's own.
const READ = 'ophis-business-alerts-read'
function alertsRead(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(READ) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

function App() {
  const hash = useSyncExternalStore(onHashChange, () => location.hash)
  const [me, setMe] = useState<Me | null>() // undefined while the first answer is on its way
  const [menu, setMenu] = useState(false)
  const [ticket, setTicket] = useState(firstTicket)
  const [stillOpen, setStillOpen] = useState(false)
  const [read, setRead] = useState(alertsRead)
  useEffect(() => {
    const next = takeTicket() // a link opened in a tab where the app is already running
    if (next) setTicket(next)
  }, [hash])
  const [closed, setClosed] = useState('') // milestone 5: 'org_frozen' or 'org_closed', the organisation of this session
  // Only the newest read lands: the refreshes of pages and actions overlap, and an older answer never overwrites a newer one (CodeRabbit, PR #1646).
  const reads = useRef(0)
  const loadMe = useCallback(async () => {
    const n = ++reads.current
    const result = await api<Me & { error?: string }>('/api/me')
    if (n !== reads.current) return
    setClosed(result.status === 403 && /^org_/.test(result.data.error ?? '') ? result.data.error! : '')
    setMe(result.status === 200 ? result.data : null)
  }, [])
  const signedOut = useCallback(() => {
    setMe(null)
    setStillOpen(false)
  }, [])
  useEffect(() => void loadMe(), [loadMe])

  // /recover is a path, not a fragment: a public page that holds no session, reached from the recovery sheet.
  // /apply too (milestone 5). An organisation that is not yet verified lands on Onboarding, an active one on Overview.
  const page = location.pathname === '/apply' ? 'apply' : location.pathname === '/recover' ? 'recover' : hash.startsWith('#/enrol') ? 'enrol' : !me ? 'signin' : hash.startsWith('#/compliance') ? 'compliance' : hash.startsWith('#/support') ? 'support' : hash.startsWith('#/onboarding') || (me.organisation.state === 'unverified' && !hash.startsWith('#/organisation')) ? 'onboarding' : hash.startsWith('#/organisation') ? 'organisation' : hash.startsWith('#/desk') ? 'desk' : 'overview'
  useEffect(() => {
    document.body.dataset.route = me ? page : 'signin'
    document.body.classList.toggle('menu-open', menu)
  }, [me, page, menu])
  useEffect(() => setMenu(false), [hash])

  async function signOut() {
    const result = await api('/api/signout', {})
    // 401: the session was already over. Any other failure: it may still be open, so the app does not pretend otherwise.
    const open = result.status !== 200 && result.status !== 401
    setStillOpen(open)
    if (open) return
    setClosed('')
    setMe(null)
    location.hash = '#/'
  }
  const current = (name: string) => (page === name ? 'page' : undefined)
  const unread = me?.alerts.filter((alert) => !read.includes(alert.key)) ?? []
  // An open account recovery stays on every page until it is closed, with what this member may do about it.
  const recovery = page === 'recover' ? undefined : me?.alerts.find((alert) => alert.kind === 'recovery')
  function markRead() {
    const next = [...read, ...unread.map((alert) => alert.key)].slice(-200)
    setRead(next)
    try {
      localStorage.setItem(READ, JSON.stringify(next))
    } catch {
      // storage is blocked: the alerts come back at the next page load, which is the safe side
    }
  }

  return (
    <>
      <button className="skip btn primary sm" type="button" onClick={() => document.getElementById('main')?.focus()}>Skip to content</button>
      {location.hostname === 'localhost' && <div className="band" role="note"><Icon name="info" size={16} /><span><strong>Local build.</strong> Test data only.</span></div>}
      <header className="bar">
        <a className="brand" href="/#/" aria-label="Ophis Business"><img src={mark} alt="" />ophis.<small>Business</small></a>
        {me && <div className="org"><span>{me.organisation.name}</span></div>}
        <nav aria-label="Before you sign in">
          <a href="/#/" aria-current={current('signin')}><Icon name="fingerprint" size={16} />Sign in</a>
          <a href="/apply" aria-current={current('apply')}><Icon name="clipboard-check" size={16} />Apply</a>
        </nav>
        <a className="btn primary sm" data-support href="/#/support" aria-current={current('support')}><Icon name="life-buoy" size={16} />Support</a>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="Main">
          {/* The server refuses both to an organisation that is not yet verified: the menu says so instead of leading back to Onboarding. */}
          {([['overview', 'layout-dashboard', 'Overview'], ['desk', 'arrow-left-right', 'Desk']] as const).map(([to, icon, label]) => me?.organisation.state === 'unverified'
            ? <button key={to} className="nav" type="button" disabled title="After verification" data-tip={`${label} (after verification)`}><Icon name={icon} /><span className="lbl">{label}</span></button>
            : <a key={to} className="nav" href={`/#/${to}`} data-tip={label} aria-current={current(to)}><Icon name={icon} /><span className="lbl">{label}</span></a>)}
          <a className="nav" href="/#/compliance" data-tip="Compliance" aria-current={current('compliance')}><Icon name="shield-check" /><span className="lbl">Compliance</span></a>
          <a className="nav" href="/#/organisation" data-tip="Organisation" aria-current={current('organisation')}><Icon name="building-2" /><span className="lbl">Organisation</span></a>
          <a className="nav" href="/#/onboarding" data-tip="Onboarding" aria-current={current('onboarding')}><Icon name="clipboard-check" /><span className="lbl">Onboarding</span></a>
          <span className="cap">Trust and help</span>
          <a className="nav" href="/#/support" data-tip="Support" aria-current={current('support')}><Icon name="life-buoy" /><span className="lbl">Support</span></a>
          {me && (
            <div className="who" data-tip="Signed in with a passkey">
              <span className="av" aria-hidden="true">{me.seat.displayName.split(' ').map((word) => word[0]).join('').slice(0, 2)}</span>
              <span className="txt"><b>{me.seat.displayName}</b>{ROLE[me.seat.role] ?? me.seat.role}</span>
              <button className="ib" type="button" aria-label="Sign out" title="Sign out" onClick={signOut}><Icon name="log-out" size={16} /></button>
            </div>
          )}
        </nav>
        <div className="col">
          <main id="main" tabIndex={-1}>
            {(me || closed) && stillOpen && <Problem>Sign-out did not work. Your session is still open. Try again.</Problem>}
            {me && recovery && <RecoveryBanner alert={recovery} organisationId={me.organisation.id} onChanged={loadMe} />}
            {page === 'apply' ? <Apply />
            : page === 'recover' ? <Recover />
            : page === 'enrol' ? <Enrol key={ticket} ticket={ticket} /> /* one per link: what an earlier link's requests answer lands nowhere (CodeRabbit, PR #1646) */
            : closed ? <Closed kind={closed} onSignOut={signOut} />
            : me === undefined ? null
            : me && unread.length ? <Alerts alerts={unread} onRead={markRead} />
            : me && page === 'compliance' ? <><Compliance onSignedOut={signedOut} /><KybRecord /></>
            : me && page === 'support' ? <Support onSignedOut={signedOut} />
            : me && page === 'onboarding' ? <Onboarding owner={me.seat.role === 'owner'} onSignedOut={signedOut} />
            : me && page === 'overview' ? <Overview onSignedOut={signedOut} />
            : me && page === 'desk' ? <Desk onSignedOut={signedOut} />
            : me ? <Organisation me={me} onSignedOut={signedOut} onChanged={loadMe} />
            : <SignIn onSignedIn={loadMe} />}
          </main>
          <footer className="foot-line">Ophis © 2026</footer>
        </div>
      </div>

      <nav className="tabbar" aria-label="Quick access">
        <a href="/#/organisation" aria-current={current('organisation')}><Icon name="building-2" size={20} />Organisation</a>
        <a href="/#/support" aria-current={current('support')}><Icon name="life-buoy" size={20} />Support</a>
        <button type="button" aria-label="Open the menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" size={20} />Menu</button>
      </nav>
      <div className="scrim" onClick={() => setMenu(false)} />
    </>
  )
}

const ComputerOnly = () => (<>
  <header className="bar"><span className="brand"><img src={mark} alt="" />ophis.<small>Business</small></span></header>
  <main id="main" className="col">
    <section className="recover">
      <header className="ph"><div>
        <h1 className="h-page">The Ophis dashboard is <em>only available from a computer</em>.</h1>
        <p className="lede">Open pro.ophis.fi on a computer. Your phone can still confirm a passkey there: scan the code the computer shows.</p>
      </div></header>
    </section>
    <footer className="foot-line">Ophis © 2026</footer>
  </main>
</>)

createRoot(document.getElementById('root')!).render(<StrictMode>{phone ? <ComputerOnly /> : <App />}</StrictMode>)
