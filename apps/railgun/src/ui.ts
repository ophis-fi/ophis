import { isError } from 'ethers'

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'Received response error from broadcaster.') {
    const reason = error.cause instanceof Error ? error.cause.message : 'No reason was supplied.'
    const detail = reason.replace(/0x[0-9a-f]{80,}/gi, '[transaction data omitted]').slice(0, 800)
    return `${error.message}\nReason: ${detail}\nUse Recovery → Check pending swap before another attempt.`
  }
  if (isError(error, 'UNKNOWN_ERROR') && error.error && typeof error.error === 'object' &&
    'message' in error.error && typeof error.error.message === 'string')
    return error.error.message
  return error instanceof Error ? error.message : 'Operation failed.'
}

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing element ${id}`)
  return found as T
}

export async function run(button: HTMLButtonElement, label: string, action: () => Promise<void>): Promise<void> {
  if (document.documentElement.dataset.busy) return
  const original = button.textContent
  const enabled = [
    ...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>(
      'button:not(:disabled):not(#lock):not(dialog button),input:not(:disabled):not(dialog input),select:not(:disabled),textarea:not(:disabled)',
    ),
  ]
  document.documentElement.dataset.busy = 'true'
  enabled.forEach((item) => {
    item.disabled = true
  })
  button.textContent = label
  element('error').textContent = ''
  try {
    await action()
  } catch (error) {
    element('error').textContent = errorMessage(error)
  } finally {
    delete document.documentElement.dataset.busy
    enabled.forEach((item) => {
      item.disabled = false
    })
    button.textContent = original
  }
}
