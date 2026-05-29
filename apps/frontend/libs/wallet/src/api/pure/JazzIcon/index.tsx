import { ReactNode, useEffect, useMemo, useRef } from 'react'

import jazzicon from '@metamask/jazzicon'
import styled from 'styled-components/macro'

const JazzIconWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
`

interface JazzIconProps {
  className?: string
  size: number
  account: string | undefined
}

export function JazzIcon({ className, size, account }: JazzIconProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null)

  const icon = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const defaultSeed = Math.floor(Math.random() * 1000000)

    // A non-hex or malformed `account` makes parseInt() return NaN, which
    // propagates into @metamask/jazzicon's hue rotation and makes its `color`
    // dependency throw on the generated value. Keep the seed a finite number.
    const parsedSeed = account ? parseInt(account.slice(2, 10), 16) : defaultSeed
    const seed = Number.isFinite(parsedSeed) ? parsedSeed : defaultSeed

    try {
      return jazzicon(size, seed)
    } catch (error) {
      // A cosmetic identicon must NEVER take down the whole app. Any throw in
      // jazzicon's color generation degrades to an empty avatar (the styled
      // wrapper still renders) instead of tripping the global error boundary.
      // (2026-05-29 production crash on swap.ophis.fi.)
      console.error('JazzIcon generation failed; rendering empty avatar', error)
      return null
    }
  }, [size, account])

  useEffect(() => {
    if (!ref.current) return

    ref.current.innerHTML = ''
    if (icon) ref.current.appendChild(icon)
  }, [icon])

  return <JazzIconWrapper ref={ref} className={className}></JazzIconWrapper>
}
