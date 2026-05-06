import { ReactNode, useCallback, useEffect } from 'react'

import { UI } from '@cowprotocol/ui'

import { animated, useSpring } from '@react-spring/web'
import { X } from 'react-feather'
import styled from 'styled-components/macro'

// Greg/Nucleus: lg radius (16), softer 1px border, token-driven padding.
const Wrapper = styled.div`
  display: inline-block;
  width: 100%;
  background-color: var(${UI.COLOR_PAPER});
  position: relative;
  border-radius: var(--greg-radius-lg, 16px);
  padding: var(--greg-space-5, 20px) 36px var(--greg-space-5, 20px) var(--greg-space-5, 20px);
  overflow: hidden;
  border: 1px solid var(${UI.COLOR_TEXT_OPACITY_25});
  box-shadow: var(--greg-shadow-medium, 0 4px 6px rgba(0, 0, 0, 0.04));
`

const ContentWrapper = styled.div`
  display: flex;
  width: 100%;
  align-items: center;
  gap: 20px;
`

const StyledClose = styled(X)`
  position: absolute;
  right: 10px;
  top: 10px;
  color: inherit;
  opacity: 0.7;
  transition: opacity ${UI.ANIMATION_DURATION} ease-in-out;

  &:hover {
    opacity: 1;
    cursor: pointer;
  }

  svg {
    stroke: currentColor;
  }
`

const Fader = styled.div`
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 2px;
  background-color: var(${UI.COLOR_PAPER_DARKER});
`

const AnimatedFader = animated(Fader)

export interface SnackbarPopupProps {
  id: string
  duration: number
  children: ReactNode
  icon: ReactNode | undefined
  onExpire(id: string): void
}

export function SnackbarPopup(props: SnackbarPopupProps): ReactNode {
  const { id, children, duration, icon, onExpire } = props

  const faderStyle = useSpring({
    from: { width: '100%' },
    to: { width: '0%' },
    config: { duration },
  })

  const removeSelf = useCallback(() => {
    onExpire(id)
  }, [id, onExpire])

  useEffect(() => {
    const timeout = setTimeout(removeSelf, duration)

    return () => clearTimeout(timeout)
  }, [duration, removeSelf])

  return (
    <Wrapper>
      <StyledClose
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          removeSelf()
        }}
      />
      <ContentWrapper>
        {icon && <div>{icon}</div>}
        <div>{children}</div>
      </ContentWrapper>
      <AnimatedFader style={faderStyle} />
    </Wrapper>
  )
}
