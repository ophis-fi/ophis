import type { MevProofReceipt } from '../types'

/**
 * Serialise a receipt to a stable, indented JSON string.
 * Keys are sorted for deterministic output (so two receipts with the same
 * data hash to the same string — useful for accounting reconciliation).
 */
export const exportJson = (receipt: MevProofReceipt): string => {
  return JSON.stringify(receipt, (_key, value) => {
    if (typeof value !== 'object' || value === null) return value
    if (Array.isArray(value)) return value
    const sorted: Record<string, unknown> = {}
    Object.keys(value).sort().forEach((k) => {
      sorted[k] = value[k as keyof typeof value]
    })
    return sorted
  }, 2)
}
