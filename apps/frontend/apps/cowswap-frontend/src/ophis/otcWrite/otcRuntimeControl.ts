import { fetchWithTimeout, withTimeout } from '@cowprotocol/common-utils'

import { isOtcMainnetMode } from './otcWriteMode.utils'

const CONTROL_TIMEOUT_MS = 4_000

async function readControl(): Promise<boolean> {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const nonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const response = await fetchWithTimeout(`/api/otc-control?nonce=${nonce}`, {
    cache: 'no-store',
    timeout: CONTROL_TIMEOUT_MS,
  })
  if (!response.ok) return false
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const control = value as Record<string, unknown>
  const mode = process.env.REACT_APP_OTC_WRITE_MODE
  return isOtcMainnetMode(mode) && control.mode === mode && control.nonce === nonce && control.enabled === true
}

export function readOtcRuntimeControl(): Promise<boolean> {
  // Cover both headers and body; a stalled response cannot leave authorization pending forever.
  return withTimeout(readControl(), CONTROL_TIMEOUT_MS, 'Ophis OTC runtime control')
}

export async function assertOtcRuntimeControl(): Promise<void> {
  if (!(await readOtcRuntimeControl())) throw new Error('Ophis OTC writes are disabled')
}
