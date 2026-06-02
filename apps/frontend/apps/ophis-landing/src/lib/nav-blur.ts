// Toggles .scrolled on the first .nav element when scrollY > 40px. Passive listener.

const nav = document.querySelector<HTMLElement>('.nav')
if (nav) {
  let lastScrolled = false
  const update = () => {
    const scrolled = window.scrollY > 40
    if (scrolled !== lastScrolled) {
      nav.classList.toggle('scrolled', scrolled)
      lastScrolled = scrolled
    }
  }
  window.addEventListener('scroll', update, { passive: true })
  update()
}

// --- Mobile nav drawer toggle ---
// Hosted in this module (not a new inline <script>) so we swap one existing CSP
// hash instead of adding a new one. The drawer/scrim markup lives outside <nav>.
const burger = document.getElementById('nav-burger')
const drawer = document.getElementById('nav-drawer')
const scrim = document.getElementById('nav-scrim')
if (burger && drawer && scrim) {
  const drawerLinks = Array.from(drawer.querySelectorAll<HTMLAnchorElement>('a'))
  const setOpen = (open: boolean) => {
    burger.setAttribute('aria-expanded', String(open))
    burger.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu')
    drawer.dataset.open = String(open)
    scrim.dataset.open = String(open)
    drawer.setAttribute('aria-hidden', String(!open))
    scrim.setAttribute('aria-hidden', String(!open))
    document.body.style.overflow = open ? 'hidden' : ''
    drawerLinks.forEach((a) => {
      a.tabIndex = open ? 0 : -1
    })
    if (open) drawerLinks[0]?.focus()
    else burger.focus()
  }
  const isOpen = () => drawer.dataset.open === 'true'
  burger.addEventListener('click', () => setOpen(!isOpen()))
  scrim.addEventListener('click', () => setOpen(false))
  // Close when a link is chosen (same-page anchors and external both).
  drawerLinks.forEach((a) => a.addEventListener('click', () => setOpen(false)))
  // Keyboard handling while open: Escape closes; Tab is trapped within the
  // burger (the close control) + drawer links, so focus can never escape to the
  // background content sitting behind the scrim.
  document.addEventListener('keydown', (e) => {
    if (!isOpen()) return
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key !== 'Tab') return
    const focusables = [burger, ...drawerLinks]
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inTrap = active !== null && focusables.includes(active)
    if (e.shiftKey) {
      if (active === first || !inTrap) {
        e.preventDefault()
        last.focus()
      }
    } else if (active === last || !inTrap) {
      e.preventDefault()
      first.focus()
    }
  })
  // Close (and clear the scroll lock) if the viewport grows past the mobile
  // breakpoint while open — e.g. an orientation change with the drawer open.
  const mq = window.matchMedia('(min-width: 721px)')
  mq.addEventListener('change', (e) => {
    if (e.matches && isOpen()) setOpen(false)
  })
}

export {}
