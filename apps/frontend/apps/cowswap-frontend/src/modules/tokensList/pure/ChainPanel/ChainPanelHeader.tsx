import { ReactNode } from 'react'

import { BackButton } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { ArrowLeft } from 'react-feather'

import * as styledEl from './styled'

import { IconButton } from '../commonElements'

export interface ChainPanelHeaderProps {
  title: string
  variant: 'default' | 'fullscreen' | 'inline'
  onClose?: () => void
}

export function ChainPanelHeader({ title, variant, onClose }: ChainPanelHeaderProps): ReactNode {
  const isFullscreen = variant !== 'default'

  return (
    <styledEl.PanelHeader $isFullscreen={isFullscreen}>
      {variant === 'inline' && onClose ? (
        <IconButton type="button" onClick={onClose} aria-label={t`Back to tokens`}>
          <ArrowLeft size={22} />
        </IconButton>
      ) : isFullscreen && onClose ? (
        <BackButton onClick={onClose} />
      ) : null}
      <styledEl.PanelTitle $isFullscreen={isFullscreen}>{title}</styledEl.PanelTitle>
      {isFullscreen && onClose ? <span /> : null}
    </styledEl.PanelHeader>
  )
}
