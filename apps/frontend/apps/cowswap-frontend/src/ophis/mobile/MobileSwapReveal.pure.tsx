import { ReactNode, useEffect, useRef } from 'react'

/** Reveal once per mount; quote updates never animate monetary values. */
export function MobileSwapReveal({ children, enabled = true }: { children: ReactNode; enabled?: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node || !window.IntersectionObserver) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (reducedMotion.matches) return
    let animation: Animation | undefined
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        animation = node.animate(
          [
            { opacity: 0, transform: 'translateY(32px) scale(.98)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 680, easing: 'cubic-bezier(.22,1,.36,1)' },
        )
        observer.disconnect()
      },
      { threshold: 0.1 },
    )
    const stop = (): void => {
      if (reducedMotion.matches) {
        animation?.cancel()
        observer.disconnect()
      }
    }
    observer.observe(node)
    reducedMotion.addEventListener('change', stop)
    return () => {
      observer.disconnect()
      animation?.cancel()
      reducedMotion.removeEventListener('change', stop)
    }
  }, [enabled])
  return <div ref={ref}>{children}</div>
}
