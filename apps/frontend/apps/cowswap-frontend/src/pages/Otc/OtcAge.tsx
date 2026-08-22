import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import { getOtcAge } from './otcDisplay'

export function OtcAge({ nowMs, createdAt }: { nowMs: number; createdAt: number | null }): ReactNode {
  const age = getOtcAge(nowMs, createdAt)
  if (!age) return '—'
  if (age.unit === 'minutes') {
    const minutes = age.value
    return <Trans>{minutes}m ago</Trans>
  }
  if (age.unit === 'hours') {
    const hours = age.value
    return <Trans>{hours}h ago</Trans>
  }
  const days = age.value
  return <Trans>{days}d ago</Trans>
}
