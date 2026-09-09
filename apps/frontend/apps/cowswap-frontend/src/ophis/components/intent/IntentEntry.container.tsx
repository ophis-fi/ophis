import { ReactNode } from 'react'

import { Navigate, useLocation } from 'react-router'

export function IntentEntry(): ReactNode {
  const { search } = useLocation()
  return <Navigate to={{ pathname: '/swap', search }} replace />
}
