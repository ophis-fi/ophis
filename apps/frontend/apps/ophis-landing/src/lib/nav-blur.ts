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

export {}
