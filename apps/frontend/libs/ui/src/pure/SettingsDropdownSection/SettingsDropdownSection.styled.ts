import { transparentize } from 'color2k'
import styled from 'styled-components/macro'

export const Section = styled.section`
  --padding: var(--ophis-space-4, 16px);

  display: flex;
  flex-direction: column;
  gap: var(--ophis-space-4, 16px);
  padding: var(--padding);

  & + & {
    padding-top: calc(var(--padding) * 1.5);
    // Same as in apps/cowswap-frontend/src/modules/tradeWidgetAddons/containers/SettingsDropdown/SettingsDropdown.styled.tsx:
    border-top: 1px solid ${({ theme }) => transparentize(theme.white, 0.95)};
  }
`

// Ophis/Nucleus: section titles are sm-bold (sm=14, weight 700).
export const Title = styled.h4`
  font-family: var(--ophis-font-body);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.005em;
  color: inherit;
  margin: 0;
`
