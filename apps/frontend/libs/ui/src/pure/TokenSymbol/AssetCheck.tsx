import { ReactNode } from 'react'

export function AssetCheck({ label }: { label: string }): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      <circle cx="8" cy="8" r="8" fill="#2775ca" />
      <path
        d="m4.5 8 2.25 2.25 4.75-4.75"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
