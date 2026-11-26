import { useAtomValue } from 'jotai'
import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import * as formStyles from '../pure/SwapForm.styled'
import { blockTimeAtom } from '../state/history.atoms'

export function SolanaSettlementTime({ slot, created }: { slot?: number; created?: string }): ReactNode {
  const start = created ? Math.floor(Date.parse(created) / 1000) : NaN
  const { data } = useAtomValue(blockTimeAtom(Number.isFinite(start) && slot !== undefined ? slot : -1))
  if (data === undefined || !Number.isFinite(start) || data < start) return null
  const seconds = data - start
  return (
    <formStyles.Line>
      <small>
        <Trans>Settlement time</Trans>
      </small>
      <strong>
        <Trans>{seconds} s</Trans>
      </strong>
    </formStyles.Line>
  )
}
