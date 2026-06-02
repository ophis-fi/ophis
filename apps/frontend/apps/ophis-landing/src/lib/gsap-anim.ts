// GSAP enhancement layer for the landing: nav entrance, scroll-linked depth
// parallax, and CTA magnetic/press micro-interactions.
//
// Scope + accessibility contract:
//  - EVERYTHING here lives inside gsap.matchMedia('(prefers-reduced-motion:
//    no-preference)'). Under prefers-reduced-motion the branch never runs, so no
//    transforms/listeners are attached and the page is fully static (the CSS
//    scroll-progress bar + bg-orbs are independently reduced-motion-gated in
//    global.css). matchMedia also auto-reverts every tween/ScrollTrigger it owns
//    if the preference flips mid-session.
//  - This is purely additive. The reveal-on-scroll system (src/lib/reveal.ts,
//    IntersectionObserver, fail-open) still owns content reveals; GSAP only adds
//    background depth, hero parallax-out, and pointer interactions on top, so a
//    failed/absent GSAP load never hides content.
//  - Bundled as an external module (gsap is ~bundled into /_assets), so it is
//    covered by CSP `script-src 'self'` with no inline hash.
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

const mm = gsap.matchMedia()

mm.add('(prefers-reduced-motion: no-preference)', () => {
  gsap.registerPlugin(ScrollTrigger)

  // 1. Nav entrance on load: a staggered drop-in.
  //    TRANSFORM ONLY — no opacity/autoAlpha. The a11y test (tests/a11y.spec.ts)
  //    runs axe immediately after load with no wait, so any element fading
  //    through partial opacity is sampled mid-flight; on the saffron logo word
  //    and muted nav links that dips below the AA contrast threshold and trips
  //    axe color-contrast. A pure translateY keeps every nav element at full
  //    opacity (full contrast) for the entire animation. Do not add autoAlpha.
  const navItems = gsap.utils.toArray<HTMLElement>('.nav-inner > *')
  if (navItems.length) {
    gsap.from(navItems, { y: -16, duration: 0.55, ease: 'power3.out', stagger: 0.07 })
  }

  // 2. Ambient background depth: the orbs drift slower than the content as you
  //    scroll, giving the page parallax depth. (Background element only.)
  const orbs = document.querySelector('.bg-orbs')
  if (orbs) {
    gsap.to(orbs, {
      yPercent: 16,
      ease: 'none',
      scrollTrigger: { trigger: document.body, start: 'top top', end: 'bottom bottom', scrub: 0.6 },
    })
  }

  // 3. Hero parallax-out: the hero content lifts and fades slightly as it leaves
  //    the viewport (a different phase from the reveal-in, so no conflict).
  const heroInner = document.querySelector('.hero-inner')
  if (heroInner) {
    gsap.to(heroInner, {
      yPercent: -10,
      autoAlpha: 0.4,
      ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
    })
  }

  // 4. CTA magnetic pull + press feedback on the primary surfaces.
  const ctas = gsap.utils.toArray<HTMLElement>('.hero .cta-primary, .hero .cta-secondary, .nav .nav-cta')
  const teardown: Array<() => void> = []
  ctas.forEach((btn) => {
    const xTo = gsap.quickTo(btn, 'x', { duration: 0.4, ease: 'power3' })
    const yTo = gsap.quickTo(btn, 'y', { duration: 0.4, ease: 'power3' })
    const onMove = (e: PointerEvent) => {
      const r = btn.getBoundingClientRect()
      xTo((e.clientX - (r.left + r.width / 2)) * 0.3)
      yTo((e.clientY - (r.top + r.height / 2)) * 0.45)
    }
    const onLeave = () => {
      xTo(0)
      yTo(0)
      gsap.to(btn, { scale: 1, duration: 0.3, ease: 'power2.out' })
    }
    const onDown = () => gsap.to(btn, { scale: 0.94, duration: 0.12, ease: 'power2.out' })
    const onUp = () => gsap.to(btn, { scale: 1, duration: 0.2, ease: 'back.out(2)' })
    btn.addEventListener('pointermove', onMove)
    btn.addEventListener('pointerleave', onLeave)
    btn.addEventListener('pointerdown', onDown)
    btn.addEventListener('pointerup', onUp)
    teardown.push(() => {
      btn.removeEventListener('pointermove', onMove)
      btn.removeEventListener('pointerleave', onLeave)
      btn.removeEventListener('pointerdown', onDown)
      btn.removeEventListener('pointerup', onUp)
    })
  })

  // matchMedia reverts GSAP tweens/ScrollTriggers automatically; remove the raw
  // pointer listeners here so a preference flip leaves no stragglers.
  return () => teardown.forEach((fn) => fn())
})

export {}
