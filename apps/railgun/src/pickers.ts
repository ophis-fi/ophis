const logos: Record<string, string> = {
  '1': 'chain-ethereum.png', '42161': 'chain-arbitrum.jpg', '137': 'chain-polygon.png', '56': 'chain-bnb.png',
  ETH: 'chain-ethereum.png', WETH: 'token-weth.png', USDC: 'token-usdc.png', USDT: 'token-usdt.png',
  POL: 'chain-polygon.png', WPOL: 'chain-polygon.png', BNB: 'chain-bnb.png', WBNB: 'chain-bnb.png',
}

function logo(value: string): HTMLImageElement | undefined {
  if (!Object.hasOwn(logos, value)) return undefined
  const image = document.createElement('img')
  image.src = new URL(`./logos/${logos[value]}`, document.baseURI).href
  image.alt = ''
  image.width = image.height = 22
  return image
}

export function configurePickers(): () => void {
  const dialog = document.getElementById('asset-picker') as HTMLDialogElement
  const search = document.getElementById('asset-search') as HTMLInputElement
  const list = document.getElementById('asset-options') as HTMLDivElement
  const close = document.getElementById('asset-close') as HTMLButtonElement
  let active: HTMLSelectElement | undefined
  let trigger: HTMLButtonElement | undefined
  const refreshers: (() => void)[] = []
  const dismiss = (): void => { dialog.close(); trigger?.focus() }
  close.onclick = dismiss
  dialog.addEventListener('cancel', () => { const button = trigger; queueMicrotask(() => button?.focus()) })
  const renderOptions = (): void => {
    list.replaceChildren()
    if (!active) return
    for (const option of active.options) {
      if (option.hidden || option.disabled || !option.text.toLowerCase().includes(search.value.toLowerCase())) continue
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'picker-option'
      const image = logo(option.value)
      if (image) row.append(image)
      const label = document.createElement('span')
      label.textContent = option.text
      row.append(label)
      if (option.selected) {
        const selected = document.createElement('span')
        selected.className = 'picker-selected'
        selected.textContent = 'Selected'
        row.append(selected)
      }
      row.onclick = () => {
        if (!active || active.matches(':disabled') || document.documentElement.dataset.busy) { dismiss(); return }
        if (active.value === option.value) { dismiss(); return }
        active.value = option.value
        // Preserve the existing invalidation and network-session handlers.
        active.dispatchEvent(new Event('input', { bubbles: true }))
        active.dispatchEvent(new Event('change', { bubbles: true }))
        refreshers.forEach(refresh => refresh())
        dismiss()
      }
      list.append(row)
    }
    if (!list.childElementCount) list.textContent = 'No matching assets.'
  }
  search.oninput = renderOptions
  dialog.onkeydown = (event) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    const rows = [...list.querySelectorAll('button')]
    if (!rows.length) return
    event.preventDefault()
    const index = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
    rows[next].focus()
  }
  for (const id of ['private-network', 'token', 'buy-token', 'shield-token']) {
    const select = document.getElementById(id) as HTMLSelectElement
    const button = document.createElement('button')
    button.id = `${id}-picker`
    button.type = 'button'
    button.className = 'asset-picker-button'
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-controls', 'asset-picker')
    const refresh = (): void => {
      const option = select.selectedOptions[0]
      button.replaceChildren()
      const image = logo(select.value)
      if (image) button.append(image)
      const label = document.createElement('span')
      label.textContent = id === 'private-network' ? option?.text || 'Choose network' : select.value
      if (option?.text.includes('(bridged)')) {
        const bridged = document.createElement('small')
        bridged.textContent = 'Bridged'
        label.append(bridged)
      }
      const chevron = document.createElement('span')
      chevron.className = 'chevron'
      chevron.setAttribute('aria-hidden', 'true')
      button.append(label, chevron)
      button.disabled = select.matches(':disabled')
      button.title = select.title
      button.setAttribute('aria-label', `${select.getAttribute('aria-label') || 'Choose asset'}: ${option?.text || label.textContent}`)
    }
    button.onclick = () => {
      if (select.matches(':disabled') || document.documentElement.dataset.busy) return
      active = select
      trigger = button
      document.getElementById('asset-title')!.textContent = id === 'private-network' ? 'Choose a network' : 'Choose a token'
      search.value = ''
      search.placeholder = id === 'private-network' ? 'Search networks' : 'Search tokens'
      search.setAttribute('aria-label', search.placeholder)
      renderOptions()
      dialog.showModal()
      search.focus()
    }
    select.after(button)
    select.hidden = true
    new MutationObserver(refresh).observe(select, { attributes: true, childList: true, subtree: true })
    refreshers.push(refresh)
    refresh()
  }
  document.addEventListener('input', () => refreshers.forEach(refresh => refresh()))
  document.addEventListener('change', () => refreshers.forEach(refresh => refresh()))
  new MutationObserver(() => refreshers.forEach(refresh => refresh()))
    .observe(document.getElementById('ready-actions')!, { attributes: true, attributeFilter: ['disabled'] })
  return () => refreshers.forEach(refresh => refresh())
}
