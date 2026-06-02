// IntersectionObserver bootstrap for [data-reveal] / .reveal-up elements.
//
// FAIL-OPEN contract: the hidden initial state in global.css is gated on
// `html.reveal-armed`, and that class is added HERE — only once we've confirmed
// IntersectionObserver exists and are about to arm the observer. So if this
// module fails to load/parse/run, or IntersectionObserver is unavailable, the
// gate is never applied and every [data-reveal] section renders FULLY VISIBLE
// instead of being stuck at opacity:0. (JS-off behaves identically — the class
// is simply never added.) This is the fix for the "JS on but reveal never runs
// -> blank page" failure mode the head-script approach left open.

if (typeof window !== 'undefined' && 'IntersectionObserver' in window) {
  const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))

  // Pre-reveal anything already in (or just below) the viewport BEFORE arming
  // the gate, so above-the-fold content never flashes hidden when the
  // `reveal-armed` class snaps the rest to opacity:0.
  const viewportH = window.innerHeight || document.documentElement.clientHeight
  for (const el of targets) {
    if (el.getBoundingClientRect().top < viewportH * 0.9) el.classList.add('in-view')
  }

  const io = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in-view')
          observer.unobserve(entry.target)
        }
      }
    },
    {
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.1,
    },
  )

  for (const el of targets) {
    if (!el.classList.contains('in-view')) io.observe(el)
  }

  // Arm the hidden state LAST — only once the observer is constructed and every
  // not-yet-revealed target is being observed. If anything above throws (the
  // constructor, observe(), etc.) the gate is never applied, so the page still
  // fails OPEN (content visible) instead of armed-hidden with no revealer.
  document.documentElement.classList.add('reveal-armed')
}

export {}
