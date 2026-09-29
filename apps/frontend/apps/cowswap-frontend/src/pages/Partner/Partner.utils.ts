export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  if (value > 0 && value < 0.01) return '<$0.01'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value > 0 && value < 1 ? 2 : 0,
  }).format(value)
}
