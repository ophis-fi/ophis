import { ReactNode } from 'react'

import cow404IMG from '@cowprotocol/assets/cow-swap/ophis-mark.svg'
import { ButtonPrimary, ExternalLink as ExternalLinkTheme, Media } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import styled from 'styled-components/macro'

import { Page, Title, Content, GdocsListStyle } from 'modules/application'

const ExternalLink = styled(ExternalLinkTheme)``

const Wrapper = styled(Page)`
  ${GdocsListStyle};
  min-height: auto;
  padding-bottom: 32px;

  ${Media.upToSmall()} {
    padding-bottom: 24px;
  }

  ${Title} {
    margin-bottom: 50px;
    font-size: 26px;

    ${Media.upToSmall()} {
      font-size: 18px;
      text-align: center;
    }
  }

  ${Content} {
    margin-bottom: 0;

    pre {
      display: inline;
    }
  }

  ${ExternalLink} {
    text-decoration: underline;
    font-weight: 800;
    color: ${({ theme }) => theme.info};
  }
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;

  ${ButtonPrimary} {
    width: 196px;
    padding: 9px;
    color: ${({ theme }) => theme.text1};

    &:hover {
    }
  }

  h2 {
    margin: 36px 0 32px;
  }

  img {
    max-width: 506px;
  }

  p {
    text-align: left;
  }

  ${Media.upToSmall()} {
    img {
      max-width: 287px;
    }
    h2 {
      font-size: 16px;
      text-align: center;
    }
  }
`

export default function AnySwapAffectedUsers(): ReactNode {
  return (
    <Wrapper>
      <Title>
        <Trans>AnySwap router security notice</Trans>
      </Title>
      <Content>
        <Container>
          <img src={cow404IMG} alt={t`Ophis`} />
          <h2>
            <Trans>Review your token approvals</Trans>
          </h2>
        </Container>
        <p>
          <Trans>
            This notice concerns approvals to <pre>AnyswapV4Router</pre>, a router affected by a critical vulnerability.
          </Trans>
        </p>
        <p>
          <Trans>
            If your wallet still has an approval for the affected contract, revoke it to protect your funds.
          </Trans>
        </p>
        <p>
          <Trans>Please read more in this</Trans>{' '}
          <ExternalLink href="https://cointelegraph.com/news/multichain-asks-users-to-revoke-approvals-amid-critical-vulnerability">
            <Trans>link</Trans>
          </ExternalLink>
          .
        </p>
      </Content>
    </Wrapper>
  )
}
