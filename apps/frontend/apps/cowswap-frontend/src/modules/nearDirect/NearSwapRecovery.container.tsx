import { useAtomValue } from 'jotai'
import { ReactNode } from 'react'

import { nearTransfersAtom } from './nearDirect.atoms'
import { Stack } from './nearDirect.styled'
import { NearTransferCard } from './NearTransferCard.container'

export function NearSwapRecovery({ allowFunding }: { allowFunding: boolean }): ReactNode {
  const transfers = useAtomValue(nearTransfersAtom)
  if (!transfers.length) return null
  return (
    <Stack>
      {!allowFunding && <p>New cross-chain swaps are paused. Existing swaps are still tracked below.</p>}
      {transfers
        .slice()
        .reverse()
        .map((transfer) => (
          <NearTransferCard key={transfer.response.signature} transfer={transfer} allowFunding={allowFunding} />
        ))}
    </Stack>
  )
}
