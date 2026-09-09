// Finite, replayable swap illustration for the landing hero band.
// Three scenes (choose assets -> review quote -> check limit) play once when
// the band scrolls into view; amounts never animate or change. No wallet,
// no network: pure illustration.
//
// Contracts:
// - Content is fully visible without JS: the markup defaults to the final
//   scene (data-scene="2"), and this module only moves between scenes.
// - prefers-reduced-motion: no autoplay, no timers; scene buttons still work.
// - The sequence stops when the page is hidden or the band leaves the
//   viewport, settling on the final scene.

function initStory(story: HTMLElement): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const stepButtons = Array.from(story.querySelectorAll<HTMLButtonElement>('[data-story-step]'))
  const replay = document.getElementById('storyReplay')
  let timers: Array<ReturnType<typeof setTimeout>> = []
  let played = false

  function selectScene(index: number): void {
    story.dataset.scene = String(index)
    for (const button of stepButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.storyStep === String(index)))
    }
  }

  function stop(): void {
    for (const timer of timers) clearTimeout(timer)
    timers = []
    story.removeAttribute('data-playing')
  }

  function play(): void {
    stop()
    if (reduced.matches) {
      selectScene(2)
      return
    }
    selectScene(0)
    // Restart the CSS entrance animations for a fresh replay.
    void story.offsetWidth
    story.setAttribute('data-playing', '')
    timers.push(setTimeout(() => selectScene(1), 800))
    timers.push(setTimeout(() => selectScene(2), 1600))
    timers.push(setTimeout(stop, 2800))
  }

  for (const button of stepButtons) {
    button.addEventListener('click', () => {
      stop()
      selectScene(Number(button.dataset.storyStep))
    })
  }
  replay?.addEventListener('click', play)

  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      stop()
      selectScene(2)
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop()
      selectScene(2)
    }
  })

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            stop()
            selectScene(2)
            continue
          }
          if (!played) {
            played = true
            play()
          }
        }
      },
      { threshold: 0.25 },
    )
    io.observe(story)
  }
}

const story = document.getElementById('swap-story')
if (story) initStory(story)

export {}
