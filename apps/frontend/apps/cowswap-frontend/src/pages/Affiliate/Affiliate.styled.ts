import styled from 'styled-components/macro'

/**
 * Shared on-brand chrome for the /affiliate and /partner pages. Mirrors the
 * saffron primary action button used on the Contact page so the affiliate
 * surfaces match the rest of the site without re-defining colors inline.
 */
export const ActionButton = styled.button`
  appearance: none;
  align-self: flex-start;
  border: none;
  border-radius: 999px;
  padding: 13px 30px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 15px;
  font-weight: 700;
  color: #02000d;
  background: #f2a63e;
  cursor: pointer;
  transition: background 120ms ease-out, transform 80ms ease-out, opacity 120ms ease-out;

  &:hover:not(:disabled) {
    background: #ffbb6e;
  }
  &:active:not(:disabled) {
    transform: translateY(1px);
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`

/**
 * Secondary, lower-emphasis action (e.g. the copy-link affordance). Ghost
 * outline in the cream foreground.
 */
export const GhostButton = styled.button`
  appearance: none;
  border: 1px solid rgba(245, 239, 230, 0.22);
  border-radius: 999px;
  padding: 8px 16px;
  font-family: 'Geist', var(--cow-font-family-primary, system-ui);
  font-size: 13px;
  font-weight: 600;
  color: #f5efe6;
  background: rgba(245, 239, 230, 0.04);
  cursor: pointer;
  transition: border-color 120ms ease-out, background 120ms ease-out, opacity 120ms ease-out;

  &:hover:not(:disabled) {
    border-color: rgba(242, 166, 62, 0.5);
    background: rgba(245, 239, 230, 0.07);
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
`

/** Row that lays out the shareable link + copy button. */
export const ShareRow = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
`

/** Grid wrapper for the stat MetricCards. */
export const MetricRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
  gap: 14px;
`
