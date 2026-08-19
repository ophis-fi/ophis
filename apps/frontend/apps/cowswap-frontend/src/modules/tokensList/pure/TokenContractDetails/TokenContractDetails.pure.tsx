import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { CheckCircle, Info } from 'react-feather'

import * as styledEl from './TokenContractDetails.styled'

export interface TokenContractDetailsProps {
  address: string
  isContractVerified: boolean
}

export function TokenContractDetails({ address, isContractVerified }: TokenContractDetailsProps): ReactNode {
  return (
    <styledEl.ContractDetails $verified={isContractVerified}>
      {isContractVerified ? <CheckCircle size={16} /> : <Info size={16} />}
      <styledEl.ContractStatus>
        {isContractVerified ? <Trans>Verified against an Ophis token list</Trans> : <Trans>Contract address</Trans>}
      </styledEl.ContractStatus>
      <styledEl.ContractAddress>{address}</styledEl.ContractAddress>
    </styledEl.ContractDetails>
  )
}
