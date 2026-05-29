import { ReactNode, useCallback } from 'react'

import { AutoRow, ButtonPrimary, MEDIA_WIDTHS } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import styled from 'styled-components/macro'
import { ThemedText } from 'theme'

import { AutoColumn } from 'legacy/components/Column'
import CopyHelper from 'legacy/components/Copy'

// eslint-disable-next-line import/no-internal-modules -- Direct import to avoid circular dependency (barrel re-exports App which imports ErrorBoundary)
import { Title } from 'modules/application/pure/Page'

/**
 * Preload the no-connection image as a data URL so it still renders if the
 * connection drops (or a stale chunk fails to load) after this point.
 */
const NO_CONNECTION_IMG = '/ophis-icon-sunset.svg'
let noConnectionIMGCache: string | null = null

function preloadNoConnectionImg(): void {
  fetch(NO_CONNECTION_IMG)
    .then((res) => res.blob())
    .then((blob) => {
      const reader = new FileReader()
      reader.readAsDataURL(blob)

      return new Promise<string>((resolve) => {
        reader.onload = function () {
          resolve(this.result as string)
        }
      })
    })
    .then((img) => {
      noConnectionIMGCache = img
    })
    .catch(() => {})
}

preloadNoConnectionImg()

const StyledTitle = styled(Title)`
  @media screen and (max-width: ${MEDIA_WIDTHS.upToSmall}px) {
    text-align: center;
  }
`

const FlexContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 0 0.5rem 0;

  @media screen and (max-width: ${MEDIA_WIDTHS.upToMedium}px) {
    flex-direction: column;
    align-items: center;
  }
`

const NoConnectionContainer = styled.div`
  text-align: center;
`

const NoConnectionDesc = styled.div`
  text-align: left;
`

const NoConnectionImg = styled.img`
  max-width: 500px;
  display: inline-block;
  margin: 20px 0;

  @media screen and (max-width: ${MEDIA_WIDTHS.upToMedium}px) {
    width: 90%;
  }
`

const AutoRowWithGap = styled(AutoRow)`
  gap: 16px;
`

const IdText = styled(ThemedText.Main)`
  opacity: 0.7;
`

const IdRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`

interface ChunkLoadErrorProps {
  eventId: string
}

export const ChunkLoadError = ({ eventId }: ChunkLoadErrorProps): ReactNode => {
  const reloadPage = useCallback(() => {
    window.location.reload()
  }, [])

  return (
    <>
      <FlexContainer>
        <StyledTitle>
          <Trans>This page can&apos;t be reached</Trans>
        </StyledTitle>
      </FlexContainer>
      <AutoColumn gap={'md'}>
        <NoConnectionContainer>
          <NoConnectionDesc>
            <p>
              <Trans>Sorry, we were unable to load the requested page.</Trans>
            </p>
            <p>
              <Trans>
                This could have happened due to the lack of internet or the release of a new version of the application.
              </Trans>
            </p>
            {eventId && (
              <IdRow>
                <IdText fontSize={14}>Event ID:</IdText>
                <CopyHelper toCopy={eventId}>{eventId}</CopyHelper>
              </IdRow>
            )}
          </NoConnectionDesc>
          {noConnectionIMGCache && <NoConnectionImg src={noConnectionIMGCache} alt={t`Ophis`} />}
        </NoConnectionContainer>
        <AutoRowWithGap justify="center">
          <ButtonPrimary width="fit-content" onClick={reloadPage}>
            <Trans>Reload page</Trans>
          </ButtonPrimary>
        </AutoRowWithGap>
      </AutoColumn>
    </>
  )
}
