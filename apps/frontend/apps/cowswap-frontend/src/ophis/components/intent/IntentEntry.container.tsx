import { ReactNode } from 'react'

import { useMediaQuery } from '@cowprotocol/common-hooks'
import { Media } from '@cowprotocol/ui'

import { Navigate, useLocation } from 'react-router'

import { IntentLanding } from './IntentLanding'

export function IntentEntry(): ReactNode {
  const isPhone = useMediaQuery(`${Media.upToSmall(false)}, (pointer: coarse) and (max-height: 500px)`)
  const { search } = useLocation()

  return isPhone ? <Navigate to={{ pathname: '/swap', search }} replace /> : <IntentLanding />
}
