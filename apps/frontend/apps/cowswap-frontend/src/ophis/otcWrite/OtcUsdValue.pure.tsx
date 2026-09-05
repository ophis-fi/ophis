import type { ReactNode } from 'react'

import * as styledEl from './OtcWrite.styled'

export function OtcUsdValue({
  amount,
  value,
  isLoading,
}: {
  amount: bigint | null
  value: string | null
  isLoading: boolean
}): ReactNode {
  if (!amount) return <styledEl.WriteHint>Enter a positive amount.</styledEl.WriteHint>
  if (isLoading) return <styledEl.WriteHint>Loading USD estimate...</styledEl.WriteHint>
  return <styledEl.WriteHint>{value ? `Approximately $${value}` : 'USD estimate unavailable'}</styledEl.WriteHint>
}
