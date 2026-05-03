import React, { useCallback } from 'react'

import { buildReceipt } from '../services/buildReceipt'
import { exportJson } from '../services/exportJson'
import { exportPdf } from '../services/exportPdf'
import type { BuildReceiptInput } from '../types'

interface DownloadReceiptButtonProps {
  readonly input: BuildReceiptInput
  readonly format?: 'json' | 'pdf'
  readonly className?: string
  readonly children?: React.ReactNode
}

const triggerDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export const DownloadReceiptButton: React.FC<DownloadReceiptButtonProps> = ({
  input,
  format = 'json',
  className,
  children,
}) => {
  const onClick = useCallback(() => {
    const receipt = buildReceipt(input)
    const shortUid = receipt.orderUid.slice(0, 10)
    if (format === 'pdf') {
      const blob = exportPdf(receipt)
      triggerDownload(blob, `greg-receipt-${shortUid}.pdf`)
    } else {
      const json = exportJson(receipt)
      const blob = new Blob([json], { type: 'application/json' })
      triggerDownload(blob, `greg-receipt-${shortUid}.json`)
    }
  }, [input, format])

  return (
    <button onClick={onClick} className={className} aria-label={`Download ${format.toUpperCase()} receipt`}>
      {children ?? `Download ${format.toUpperCase()} receipt`}
    </button>
  )
}
