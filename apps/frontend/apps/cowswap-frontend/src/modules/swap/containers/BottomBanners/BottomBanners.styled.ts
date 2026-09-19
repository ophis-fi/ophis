import { Link } from 'react-router'
import styled, { keyframes } from 'styled-components/macro'
import { WIDGET_MAX_WIDTH } from 'theme'

export const Wrapper = styled.div`
  display: flex;
  flex-flow: column wrap;
  gap: 10px;
  width: 100%;
  max-width: ${WIDGET_MAX_WIDTH.swap};
  margin: 0 auto;
`

const giftWiggle = keyframes`
  0%, 100% { transform: rotate(0); }
  25% { transform: rotate(-12deg); }
  75% { transform: rotate(12deg); }
`

export const Giveaway = styled(Link)`
  display: block;
  padding: 20px;
  margin-top: 12px;
  border: 1px solid var(--ophis-steep-line);
  border-radius: 18px;
  background: var(--ophis-steep-mist);
  color: var(--ophis-steep-ink);
  text-decoration: none;

  > strong {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 18px;
    line-height: 1.4;
  }

  > strong > svg {
    flex-shrink: 0;
    animation: ${giftWiggle} 600ms ease-in-out 2;
  }

  > p {
    margin: 8px 0 6px;
    font-size: 14px;
    line-height: 1.5;
  }

  > small {
    display: block;
    font-size: 11px;
    line-height: 1.5;
  }

  > span {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--ophis-steep-line);
    font-size: 13px;
    font-weight: 600;
  }

  > span > svg {
    transition: transform 180ms ease;
  }

  &:hover > span > svg {
    transform: translateX(3px);
  }

  &:focus-visible {
    outline: 2px solid var(--ophis-steep-ink);
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    > strong > svg,
    > span > svg {
      animation: none;
      transition: none;
      transform: none;
    }
  }
`
