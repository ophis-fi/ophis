// IntersectionObserver bootstrap. Targets [data-reveal] elements with .reveal-up base class.
// Adds .in-view when element enters viewport. Idempotent: stops observing after first reveal.

const targets = document.querySelectorAll<HTMLElement>('[data-reveal]')

if (targets.length === 0) {
  // nothing to do; export below for tree-shaking guards
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
  }
)

targets.forEach((el) => io.observe(el))

export {}
