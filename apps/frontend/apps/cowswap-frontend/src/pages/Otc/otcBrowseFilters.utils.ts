import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'

import type { OtcDisplayRow } from './otcDisplay'

export interface BrowseFilters {
  token: string
  maker: string
  orderId: string
}

export const EMPTY_BROWSE_FILTERS: BrowseFilters = { token: '', maker: '', orderId: '' }

export function applyBrowseFilters(rows: OtcDisplayRow[], filters: BrowseFilters): OtcDisplayRow[] {
  return rows.filter((row) => {
    if (filters.orderId.trim() !== '' && row.order.orderId.toString() !== filters.orderId.trim()) return false
    if (filters.maker.trim() !== '' && !getAddressKey(row.order.maker).includes(filters.maker.trim().toLowerCase())) {
      return false
    }
    if (filters.token !== '') {
      if (!areAddressesEqual(row.order.tokenA, filters.token) && !areAddressesEqual(row.order.tokenB, filters.token)) {
        return false
      }
    }
    return true
  })
}
