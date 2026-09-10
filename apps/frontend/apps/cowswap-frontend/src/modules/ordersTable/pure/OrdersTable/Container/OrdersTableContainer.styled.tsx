import { ExternalLink, Media, UI } from '@cowprotocol/ui'

import { STEEP_FONT } from 'ophis/ds'
import styled from 'styled-components/macro'

export const Wrapper = styled.div`
  display: flex;
  flex-flow: column wrap;
  gap: 16px;
  width: 100%;
`

export const Content = styled.div`
  display: flex;
  flex-flow: column nowrap;
  align-items: center;
  justify-content: center;
  color: var(${UI.COLOR_TEXT_PAPER});
  min-height: 300px;
  padding: 40px 16px;
  gap: 16px;

  > h3,
  > h4 {
    font-family: ${STEEP_FONT.display};
    font-size: clamp(24px, 2.5vw, 32px);
    line-height: 1.2;
    font-weight: 400;
    letter-spacing: -0.02em;
    margin: 0 auto;
    text-align: center;
    color: inherit;
  }

  > p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0 auto;
    font-weight: 400;
    text-align: center;
    color: inherit;
  }

  ${Media.upToMedium()} {
    min-height: 0;
    padding: 32px 12px;
  }
`
export const ContentDescription = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 44ch;
  color: var(${UI.COLOR_TEXT_OPACITY_70});

  > p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0 auto;
    font-weight: 400;
    text-align: center;
    color: inherit;
  }
`

export const ConnectWalletIconWrapper = styled.span`
  --size: 72px;
  --backgroundColor: var(${UI.COLOR_PAPER_DARKER});
  --iconFillColor: var(${UI.COLOR_TEXT});
  --iconColor: var(${UI.COLOR_TEXT});

  width: var(--size);
  height: var(--size);
  border-radius: var(--size);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  margin: 0;
  color: inherit;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--backgroundColor);
    border-radius: var(--size);
    z-index: -1;
  }

  > svg,
  > img {
    max-width: 100%;
    max-height: 100%;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: inline;
  }

  > svg {
    padding: 18px;
    fill: var(--iconFillColor);
    color: var(--iconColor);
  }
`

export const UnsupportedNetworkIconWrapper = styled(ConnectWalletIconWrapper)`
  --backgroundColor: var(${UI.COLOR_DANGER_BG});
  --iconFillColor: transparent;
  --iconColor: var(${UI.COLOR_DANGER_TEXT});
`

export const NoOrdersArtwork = styled.div`
  width: 100%;
  max-width: 320px;
  margin: 8px auto 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;

  > img {
    width: 100%;
    height: auto;
    object-fit: contain;
  }
`

export const TopContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 3px;
  min-height: 36px;

  ${Media.upToMedium()} {
    display: block;
    text-align: center;

    > h2 {
      margin-bottom: 15px !important;
    }
  }

  > h2 {
    font-size: 24px;
    margin: 0;
  }
`

export const TabsContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  ${Media.upToMedium()} {
    flex-direction: column;
    align-items: end;
    gap: 10px;
  }
`

export const ExternalLinkStyled = styled(ExternalLink)`
  text-decoration: underline;
`

// Todo: Makes this arrow default behavior of <ExternalLink />
export const ExternalArrow = styled.span`
  display: inline-block;
  &::after {
    content: ' ↗';
    display: inline-block;
    padding: 0 0 0 1px;
    font-weight: bold;
    font-size: 11px;
  }
`

export const RightContainer = styled.div<{ $isHistoryTab: boolean }>`
  display: flex;
  flex-flow: row nowrap;

  ${Media.upToMedium()} {
    width: 100%;
    gap: 10px;
    flex-flow: ${({ $isHistoryTab }) => ($isHistoryTab ? 'column wrap' : 'column-reverse wrap')};
  }
`

export const BannerContainer = styled.div`
  width: 100%;
`
