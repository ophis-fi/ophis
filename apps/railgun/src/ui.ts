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
      'button:not(:disabled):not(#lock),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
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
    element('error').textContent = error instanceof Error ? error.message : 'Operation failed.'
  } finally {
    delete document.documentElement.dataset.busy
    enabled.forEach((item) => {
      item.disabled = false
    })
    button.textContent = original
  }
}
