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
    if (filters.maker.trim() !== '' && !row.order.maker.toLowerCase().includes(filters.maker.trim().toLowerCase())) {
      return false
    }
    if (filters.token !== '') {
      const needle = filters.token.toLowerCase()
      if (row.order.tokenA.toLowerCase() !== needle && row.order.tokenB.toLowerCase() !== needle) return false
    }
    return true
  })
}
