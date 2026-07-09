/**
 * Styled components for the Cash Prize page. Extracted per the AGENTS.md
 * convention (renderer stays under the 250-LOC cap).
 */
import styled from 'styled-components/macro'

export const XpRow = styled.div`
  display: flex;
  align-items: center;
  gap: 28px;
  flex-wrap: wrap;
`

export const XpFacts = styled.div`
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;

  > p {
    margin: 0;
  }
`

export const PerkGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
`

export const PerkCard = styled.article`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border-radius: 16px;
  border: 1px solid rgba(245, 239, 230, 0.12);
  background: rgba(245, 239, 230, 0.03);
`

export const PerkHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

export const PerkPartner = styled.span`
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.7;
`

export const PerkTitle = styled.h3`
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
`

export const PerkDescription = styled.p`
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  opacity: 0.75;
`

export const PerkFooter = styled.div`
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
`

export const ProgressTrack = styled.div`
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: rgba(245, 239, 230, 0.1);
  overflow: hidden;
`

export const ProgressFill = styled.div<{ $pct: number }>`
  width: ${({ $pct }) => Math.max(0, Math.min(100, $pct))}%;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #f2a63e, #d960b5, #7a6ee0);
`

export const ProgressLabel = styled.span`
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  opacity: 0.65;
`

export const ClaimButton = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  align-self: flex-start;
  padding: 9px 18px;
  border-radius: 12px;
  font-size: 13.5px;
  font-weight: 600;
  text-decoration: none;
  color: #131214;
  background: #f2a63e;
  transition: background 120ms ease;

  &:hover,
  &:focus-visible {
    background: #ffb95a;
  }
`
