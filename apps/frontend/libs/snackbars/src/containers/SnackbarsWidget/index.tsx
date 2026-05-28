import { useAtomValue, useSetAtom } from 'jotai'
import { useResetAtom } from 'jotai/utils'
import React, { ReactElement, ReactNode, useCallback, useEffect, useMemo } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { Media, UI } from '@cowprotocol/ui'

import { animated, useTransition } from '@react-spring/web'
import ms from 'ms.macro'
import { AlertTriangle, CheckCircle } from 'react-feather'
import styled from 'styled-components/macro'

import { useAnchorPosition } from '../../hooks/useAnchorPosition'
import { SnackbarPopup } from '../../pure/SnackbarPopup'
import { IconType, removeSnackbarAtom, snackbarsAtom } from '../../state/snackbarsAtom'

const Overlay = styled.div`
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 4;
  background: var(${UI.COLOR_BLACK_OPACITY_30});
  backdrop-filter: blur(10px);
`

const List = styled.div`
  position: relative;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const Host = styled.div<{ hidden$: boolean; top$: number }>`
  position: fixed;
  top: ${({ top$ }) => top$ + 'px'};
  right: ${({ hidden$ }) => (hidden$ ? '-9999px' : '20px')};
  z-index: 10;
  min-width: 300px;
  max-width: 800px;

  ${Media.upToSmall()} {
    width: 90%;
    left: 0;
    right: ${({ hidden$ }) => (hidden$ ? '-9999px' : '0')};
    margin: auto;

    ${Overlay} {
      display: block;
    }
  }
`

const SuccessIcon = styled(CheckCircle)`
  color: ${({ theme }) => theme.green1};
`

const AlertIcon = styled(AlertTriangle)`
  color: ${({ theme }) => theme.danger};
`

const DEFAULT_DURATION = ms`8s`

const icons: Record<IconType, ReactElement | undefined> = {
  success: <SuccessIcon size={24} />,
  alert: <AlertIcon size={24} />,
  custom: undefined,
}

const WIDGET_DEFAULT_TOP_POSITION = 80

// React 19 dropped implicit `children` from HTMLAttributes, so animated.div
// doesn't accept children in its own JSX type. We work around it by creating
// a plain-div wrapper whose style is driven by a react-spring SpringValue ref
// prop. This preserves the animated interpolation while staying type-safe.
const AnimatedSlide = animated(
  function SlideWrapper({
    children,
    style,
  }: {
    children?: ReactNode
    style?: React.CSSProperties
  }) {
    return <div style={style}>{children}</div>
  },
)

interface SnackbarsWidgetProps {
  /**
   * This prop might seem a bit hacky and this is true
   * The problem in `OrderNotification` and `getToastMessageCallback` functions
   * In widget mode with `disableToastMessages` option we want to display notifications on the integrator side
   * To do that, we need to render `OrderNotification` but not display it in the widget
   * Having this, we use this flag to artificially hide the widget
   */
  hidden?: boolean
  /**
   * Id of a DOM element to which the snackbars should be anchored (displayed under)
   * In CoW Swap the header menu
   */
  anchorElementId?: string
}

export function SnackbarsWidget({ hidden, anchorElementId }: SnackbarsWidgetProps): ReactNode {
  const snackbarsState = useAtomValue(snackbarsAtom)
  const resetSnackbarsState = useResetAtom(snackbarsAtom)
  const removeSnackbar = useSetAtom(removeSnackbarAtom)

  const { top, height } = useAnchorPosition(anchorElementId)
  const widgetTop = top + height || WIDGET_DEFAULT_TOP_POSITION

  const snackbars = useMemo(() => {
    return Object.values(snackbarsState)
  }, [snackbarsState])

  const onExpire = useCallback(
    (id: string) => {
      removeSnackbar(id)
    },
    [removeSnackbar],
  )

  const isUpToSmall = useMediaQuery(Media.upToSmall(false))
  const isOverlayDisplayed = snackbars.length > 0 && !hidden && isUpToSmall

  useEffect(() => {
    document.body.style.overflow = isOverlayDisplayed ? 'hidden' : ''
  }, [isOverlayDisplayed])

  // Slide-from-right enter/exit animation for each snackbar.
  // Uses @react-spring/web (already in this lib's deps) so no new dep is added.
  // prefers-reduced-motion: the spring config uses a near-zero duration so the
  // values jump instantly — the CSS media query `@media (prefers-reduced-motion)`
  // cannot apply to JS springs, but immediate:true achieves the same result.
  const prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const transitions = useTransition(snackbars, {
    keys: (snackbar) => snackbar.id,
    from: { opacity: 0, transform: 'translateX(60px) scale(0.95)' },
    enter: { opacity: 1, transform: 'translateX(0px) scale(1)' },
    leave: { opacity: 0, transform: 'translateX(60px) scale(0.95)' },
    config: prefersReducedMotion
      ? { duration: 0 }
      : { tension: 320, friction: 26 }, // ~220ms snappy ease-out
  })

  return (
    <Host hidden$={!!hidden} top$={widgetTop}>
      <List>
        {transitions((style, snackbar) => {
          const icon = snackbar.icon
            ? snackbar.icon === 'custom'
              ? snackbar.customIcon
              : icons[snackbar.icon]
            : undefined

          const duration = snackbar.duration ?? DEFAULT_DURATION

          return (
            <AnimatedSlide key={snackbar.id} style={style}>
              <SnackbarPopup id={snackbar.id} icon={icon} duration={duration} onExpire={onExpire}>
                {snackbar.content}
              </SnackbarPopup>
            </AnimatedSlide>
          )
        })}
      </List>
      {isOverlayDisplayed && <Overlay onClick={resetSnackbarsState} />}
    </Host>
  )
}
