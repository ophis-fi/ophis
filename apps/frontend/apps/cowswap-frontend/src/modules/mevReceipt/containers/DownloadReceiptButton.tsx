import React, { useCallback, useState } from 'react'

import { buildReceipt } from '../services/buildReceipt'
import { exportJson } from '../services/exportJson'
import { exportPdf } from '../services/exportPdf'
import { fetchPathViz } from '../services/fetchPathViz'
import { svgToPng } from '../services/svgToPng'
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
  const [busy, setBusy] = useState(false)

  const onClick = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      // Best-effort pathviz fetch (Optimism only, 3 s cap). A failure leaves
      // the field null and the receipt is produced without the diagram.
      const pathVizSvgBase64 = await fetchPathViz({ orderUid: input.order.uid, chainId: input.chainId })
      const receipt = buildReceipt({ ...input, pathVizSvgBase64 })
      const shortUid = receipt.orderUid.slice(0, 10)

      if (format === 'pdf') {
        const rasterized = pathVizSvgBase64 ? await svgToPng(pathVizSvgBase64) : null
        const blob = exportPdf(receipt, rasterized)
        triggerDownload(blob, `ophis-receipt-${shortUid}.pdf`)
      } else {
        const json = exportJson(receipt)
        const blob = new Blob([json], { type: 'application/json' })
        triggerDownload(blob, `ophis-receipt-${shortUid}.json`)
      }
    } finally {
      setBusy(false)
    }
  }, [busy, input, format])

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={className}
      aria-label={`Download ${format.toUpperCase()} receipt`}
    >
      {children ?? `Download ${format.toUpperCase()} receipt`}
    </button>
  )
}
