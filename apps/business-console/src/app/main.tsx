// App shell: band, bar, rail, footer line. Routes live in the URL fragment, as in the mockup.
import { StrictMode, useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import './kit.css'
import './app.css'
import mark from './assets/ophis-icon-mono-dark.svg'
import { Alerts, Enrol, Organisation, Problem, Security, SignIn, type Me } from './pages.tsx'
import { api, Icon, ROLE, Status } from './ui.tsx'

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
const firstTicket = takeTicket() ?? ''

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

function Later({ icon, label }: { icon: string; label: string }) {
  return <button className="nav" type="button" disabled data-tip={`${label} (later)`}><Icon name={icon} /><span className="lbl">{label}</span><Status>Later</Status></button>
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
  const loadMe = useCallback(async () => {
    const result = await api<Me>('/api/me')
    setMe(result.status === 200 ? result.data : null)
  }, [])
  const signedOut = useCallback(() => {
    setMe(null)
    setStillOpen(false)
  }, [])
  useEffect(() => void loadMe(), [loadMe])

  const page = hash.startsWith('#/security') ? 'security' : hash.startsWith('#/enrol') ? 'enrol' : me ? 'organisation' : 'signin'
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
    setMe(null)
    location.hash = '#/'
  }
  const current = (name: string) => (page === name ? 'page' : undefined)
  const unread = me?.alerts.filter((alert) => !read.includes(alert.key)) ?? []
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
      <div className="band" role="note"><Icon name="info" size={16} /><span><strong>Local build.</strong> Milestone 2 of 6: enrolment and recovery ceremony. Test data only.</span></div>
      <header className="bar">
        <a className="brand" href="#/" aria-label="Ophis Business"><img src={mark} alt="" />ophis.<small>Business</small></a>
        {me && <div className="org"><span>{me.organisation.name}</span></div>}
        <nav aria-label="Before you sign in">
          <a href="#/" aria-current={current('signin')}><Icon name="fingerprint" size={16} />Sign in</a>
          <a href="#/security" aria-current={current('security')}><Icon name="lock-keyhole" size={16} />Security and data</a>
        </nav>
        <button className="btn primary sm" type="button" data-support disabled title="Support arrives in a later milestone"><Icon name="life-buoy" size={16} />Support</button>
      </header>

      <div className="shell">
        <nav className="rail" aria-label="Main">
          <Later icon="layout-dashboard" label="Overview" />
          <Later icon="arrow-left-right" label="Desk" />
          <Later icon="shield-check" label="Compliance" />
          <a className="nav" href="#/organisation" data-tip="Organisation" aria-current={current('organisation')}><Icon name="building-2" /><span className="lbl">Organisation</span></a>
          <Later icon="clipboard-check" label="Onboarding" />
          <span className="cap">Trust and help</span>
          <a className="nav" href="#/security" data-tip="Security and data" aria-current={current('security')}><Icon name="lock-keyhole" /><span className="lbl">Security and data</span></a>
          <Later icon="life-buoy" label="Support" />
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
            {me && stillOpen && <Problem>Sign-out did not work. Your session is still open. Try again.</Problem>}
            {page === 'security' ? <Security />
            : page === 'enrol' ? <Enrol ticket={ticket} />
            : me === undefined ? null
            : me && unread.length ? <Alerts alerts={unread} onRead={markRead} />
            : me ? <Organisation me={me} onSignedOut={signedOut} onChanged={loadMe} />
            : <SignIn onSignedIn={loadMe} />}
          </main>
          <footer className="foot-line">Ophis is a software provider. It is not a crypto-asset service provider.</footer>
        </div>
      </div>

      <nav className="tabbar" aria-label="Quick access">
        <a href="#/organisation" aria-current={current('organisation')}><Icon name="building-2" size={20} />Organisation</a>
        <a href="#/security" aria-current={current('security')}><Icon name="lock-keyhole" size={20} />Security</a>
        <button type="button" aria-label="Open the menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="menu" size={20} />Menu</button>
      </nav>
      <div className="scrim" onClick={() => setMenu(false)} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
