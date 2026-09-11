// A looping walkthrough. Pause when hidden, outside the viewport, or reduced motion is requested.
function initStory(story: HTMLElement): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const steps = Array.from(story.querySelectorAll<HTMLButtonElement>('[data-story-step]'))
  const panels = Array.from(story.querySelectorAll<HTMLElement>('[data-story-panel]'))
  const pauseControl = story.querySelector<HTMLButtonElement>('#storyPause')
  if (!pauseControl) return
  const pause = pauseControl
  let scene = 0
  let inView = false
  let paused = reduced.matches
  let timer: ReturnType<typeof setInterval> | undefined

  function selectScene(index: number): void {
    scene = index
    story.dataset.scene = String(index)
    steps.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)))
    panels.forEach((panel, i) => {
      panel.hidden = i !== index
    })
  }

  function syncPlayback(): void {
    clearInterval(timer)
    timer = undefined
    const playing = inView && !document.hidden && !paused && !reduced.matches
    story.toggleAttribute('data-playing', playing)
    pause.textContent = paused || reduced.matches ? 'Resume' : 'Pause'
    pause.setAttribute(
      'aria-label',
      paused || reduced.matches ? 'Resume workflow animation' : 'Pause workflow animation',
    )
    pause.hidden = reduced.matches
    if (playing) timer = setInterval(() => selectScene((scene + 1) % panels.length), 4500)
  }

  steps.forEach((button, index) =>
    button.addEventListener('click', () => {
      paused = true
      selectScene(index)
      syncPlayback()
    }),
  )
  pause.addEventListener('click', () => {
    paused = !paused
    syncPlayback()
  })
  reduced.addEventListener('change', () => {
    paused = reduced.matches
    syncPlayback()
  })
  document.addEventListener('visibilitychange', syncPlayback)
  const observer = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting)
      syncPlayback()
    },
    { threshold: 0.2 },
  )
  observer.observe(story)
  syncPlayback()
}

const story = document.getElementById('swap-story')
if (story) initStory(story)
export {}
