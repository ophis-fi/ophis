/**
 * Styled components for the Rewards page. Extracted per the AGENTS.md
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
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  gap: 16px;
`

export const PerkCard = styled.article`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px;
  border-radius: 16px;
  border: 1px solid var(--cow-color-border);
  background: var(--cow-color-paper-darker);
`

export const PerkHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

export const PartnerLogo = styled.img`
  /* Wide wordmark logos (e.g. Octav 996x181): fix the height, let width follow. */
  height: 18px;
  width: auto;
  box-sizing: content-box;
  padding: 6px 8px;
  border-radius: 6px;
  background: #17191c;
  display: block;
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
  background: var(--cow-color-paper-darker);
  overflow: hidden;
`

export const ProgressFill = styled.div<{ $pct: number }>`
  width: ${({ $pct }) => Math.max(0, Math.min(100, $pct))}%;
  height: 100%;
  border-radius: 3px;
  background: var(--cow-color-primary);
`

export const ProgressLabel = styled.span`
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 12px;
  color: var(--cow-color-text-opacity-70);
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
  color: var(--cow-color-button-text);
  background: var(--cow-color-primary);
  transition: background 120ms ease;

  &:hover,
  &:focus-visible {
    background: var(--cow-color-primary-darker);
  }
`

export const ClaimActionButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  align-self: flex-start;
  padding: 9px 18px;
  border: 0;
  border-radius: 12px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
  color: var(--cow-color-button-text);
  background: var(--cow-color-primary);
  transition: background 120ms ease;

  &:hover,
  &:focus-visible {
    background: var(--cow-color-primary-darker);
  }

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`

export const ClaimPanel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;

  > p {
    margin: 0;
    font-size: 13.5px;
  }
`

export const RedeemRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

export const CodeChip = styled.span`
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--cow-color-primary);
  padding: 6px 12px;
  border-radius: 10px;
  border: 1px dashed var(--cow-color-primary);
  background: var(--cow-color-paper-darker);
  /* Single click selects the whole code for easy copy. */
  user-select: all;
`

export const ClaimNote = styled.span`
  font-size: 12px;
  color: var(--cow-color-text-opacity-70);
  line-height: 1.4;
`

/* Claim form (partner-fulfilled perks): the email the partner mails the code to,
   posted to the rebate indexer so the partner has a list to issue codes from. */
export const ClaimForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

export const ClaimLabel = styled.label`
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12.5px;
  font-weight: 500;
  opacity: 0.8;
`

export const ClaimInput = styled.input`
  font-family: var(--cow-font-family-primary, system-ui);
  font-size: 14px;
  color: inherit;
  background: var(--cow-color-paper);
  border: 1px solid var(--cow-color-border);
  border-radius: 10px;
  padding: 9px 12px;
  transition:
    border-color 120ms ease-out,
    box-shadow 120ms ease-out;

  &::placeholder {
    color: var(--cow-color-text-opacity-70);
    opacity: 1;
  }
  &:focus {
    border-color: var(--cow-color-primary);
    outline: 2px solid var(--cow-color-primary);
    outline-offset: 2px;
  }
  &:disabled {
    opacity: 0.6;
  }
`
