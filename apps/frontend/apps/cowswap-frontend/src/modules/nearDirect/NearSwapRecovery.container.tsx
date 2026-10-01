import { useAtomValue } from 'jotai'
import { ReactNode } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { nearTokensAtom, nearTransfersAtom } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import { Stack } from './nearDirect.styled'
import { NearTransferCard } from './NearTransferCard.container'

export function NearSwapRecovery({ allowFunding }: { allowFunding: boolean }): ReactNode {
  const transfers = useAtomValue(nearTransfersAtom)
  if (!transfers.length) return null
  return <RecoveryTransfers transfers={transfers} allowFunding={allowFunding} />
}

function RecoveryTransfers({
  transfers,
  allowFunding,
}: {
  transfers: NearTransfer[]
  allowFunding: boolean
}): ReactNode {
  const { error, refetch } = useAtomValue(nearTokensAtom)
  return (
    <Stack>
      {error && (
        <>
          <p role="alert">Unable to verify swap assets. Please try again.</p>
          <ButtonSecondary onClick={() => refetch()}>Retry loading assets</ButtonSecondary>
        </>
      )}
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
