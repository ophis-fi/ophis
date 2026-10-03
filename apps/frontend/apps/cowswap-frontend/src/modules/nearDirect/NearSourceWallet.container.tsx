import { ReactNode } from 'react'

import { NearToken } from './nearDirect.schemas'
import { StandardWallet } from './StandardWallet.container'
import { StarknetWallet } from './StarknetWallet.container'
import { TronWallet } from './TronWallet.container'

export function NearSourceWallet({
  source,
  onConnect,
  disabled = false,
}: {
  source: NearToken | undefined
  onConnect?: (address: string) => void
  disabled?: boolean
}): ReactNode {
  switch (source?.blockchain) {
    case 'sol':
    case 'sui':
      return (
        <StandardWallet key={source.blockchain} chain={source.blockchain} onConnect={onConnect} disabled={disabled} />
      )
    case 'tron':
      return <TronWallet onConnect={onConnect} disabled={disabled} />
    default:
      return <StarknetWallet source={source} onConnect={onConnect} disabled={disabled} />
  }
}
