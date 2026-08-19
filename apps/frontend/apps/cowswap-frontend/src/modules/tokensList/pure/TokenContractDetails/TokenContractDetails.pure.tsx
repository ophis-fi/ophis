import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { CheckCircle, Info } from 'react-feather'

import * as styledEl from './TokenContractDetails.styled'

export interface TokenContractDetailsProps {
  address: string
  isContractListed: boolean
}

export function TokenContractDetails({ address, isContractListed }: TokenContractDetailsProps): ReactNode {
  return (
    <styledEl.ContractDetails $listed={isContractListed}>
      {isContractListed ? <CheckCircle size={16} /> : <Info size={16} />}
      <styledEl.ContractStatus>
        {isContractListed ? <Trans>Listed by a configured token source</Trans> : <Trans>Contract address</Trans>}
      </styledEl.ContractStatus>
      <styledEl.ContractAddress>{address}</styledEl.ContractAddress>
    </styledEl.ContractDetails>
  )
}
