const logos: Record<string, string> = {
  '1': 'chain-ethereum.png', '42161': 'chain-arbitrum.jpg', '137': 'chain-polygon.png', '56': 'chain-bnb.png',
  ETH: 'chain-ethereum.png', WETH: 'token-weth.png', USDC: 'token-usdc.png', USDT: 'token-usdt.png',
  POL: 'chain-polygon.png', WPOL: 'chain-polygon.png', BNB: 'chain-bnb.png', WBNB: 'chain-bnb.png',
}

function logo(value: string): HTMLImageElement | undefined {
  if (!Object.hasOwn(logos, value) && !/^0x[0-9a-f]{40}$/.test(value)) return undefined
  const image = document.createElement('img')
  image.src = new URL(`./logos/${logos[value] || 'token-unknown.png'}`, document.baseURI).href
  image.alt = ''
  image.width = image.height = 22
  return image
}

export function configurePickers(importToken?: (address: string) => Promise<string>): () => void {
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
    const query = search.value.trim().toLowerCase()
    const addressSearch = /^0x[0-9a-f]{40}$/.test(query)
    for (const option of active.options) {
      if (option.hidden || option.disabled || (addressSearch
        ? option.dataset.address?.toLowerCase() !== query : !option.text.toLowerCase().includes(query))) continue
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'picker-option'
      const image = logo(option.value)
      if (image) row.append(image)
      const label = document.createElement('span')
      label.textContent = option.value.startsWith('0x') ? option.dataset.symbol || 'Token in your private wallet' : option.text
      if (option.value.startsWith('0x')) {
        const address = document.createElement('small')
        address.textContent = `Custom token · Contract: ${option.dataset.address || option.value}`
        label.append(address)
      }
      row.append(label)
      if (option.selected) {
        const selected = document.createElement('span')
        selected.className = 'picker-selected'
        selected.textContent = 'Selected'
        row.append(selected)
      }
      row.onclick = async () => {
        if (!active || active.matches(':disabled') || document.documentElement.dataset.busy) { dismiss(); return }
        if (active.value === option.value) { dismiss(); return }
        const target = active, query = search.value
        let id = option.value
        if (option.dataset.pendingMetadata === 'true') {
          if (!importToken) return
          row.disabled = true
          try { id = await importToken(option.dataset.address || option.value) }
          catch (error) { row.textContent = error instanceof Error ? error.message : 'Token lookup failed.'; row.disabled = false; return }
          if (!dialog.open || active !== target || search.value !== query || target.matches(':disabled') || document.documentElement.dataset.busy) return
        }
        target.value = id
        // Preserve the existing invalidation and network-session handlers.
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.dispatchEvent(new Event('change', { bubbles: true }))
        refreshers.forEach(refresh => refresh())
        dismiss()
      }
      list.append(row)
    }
    if (!list.childElementCount) list.textContent = 'No matching assets.'
    if (active.id !== 'private-network' && /^0x[0-9a-fA-F]{40}$/.test(search.value.trim()) && importToken &&
      ![...active.options].some(option => option.dataset.address?.toLowerCase() === query)) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'picker-option'
      row.textContent = 'Find token by contract address'
      row.onclick = async () => {
        if (!active || active.matches(':disabled') || document.documentElement.dataset.busy) return
        const target = active, address = search.value.trim()
        row.disabled = true
        row.textContent = 'Checking token…'
        try {
          const id = await importToken(address)
          if (!dialog.open || active !== target || search.value.trim() !== address || target.matches(':disabled') || document.documentElement.dataset.busy) return
          target.value = id
          target.dispatchEvent(new Event('input', { bubbles: true }))
          target.dispatchEvent(new Event('change', { bubbles: true }))
          refreshers.forEach(refresh => refresh())
          dismiss()
        } catch (error) {
          row.textContent = error instanceof Error ? error.message : 'Token lookup failed. Try again.'
          row.disabled = false
        }
      }
      list.append(row)
    }
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
      for (const label of select.labels ?? []) label.htmlFor = button.id
      const option = select.selectedOptions[0]
      button.replaceChildren()
      const image = logo(select.value)
      if (image) button.append(image)
      const label = document.createElement('span')
      label.textContent = id === 'private-network' ? option?.text || 'Choose network' : option?.dataset.symbol || select.value
      if (option?.dataset.bridged === 'true') {
        const bridged = document.createElement('small')
        bridged.textContent = 'Bridged'
        label.append(bridged)
      }
      if (select.value.startsWith('0x')) {
        const address = document.createElement('small')
        address.textContent = `Custom · ${select.value.slice(0, 6)}…${select.value.slice(-4)}`
        label.append(address)
      }
      const chevron = document.createElement('span')
      chevron.className = 'chevron'
      chevron.setAttribute('aria-hidden', 'true')
      button.append(label, chevron)
      button.disabled = select.matches(':disabled')
      button.title = select.title || option?.text || ''
      button.setAttribute('aria-label', `${select.getAttribute('aria-label') || 'Choose asset'}: ${select.value.startsWith('0x') ? 'Custom token · ' : ''}${option?.text || label.textContent}`)
    }
    button.onclick = () => {
      if (select.matches(':disabled') || document.documentElement.dataset.busy) return
      active = select
      trigger = button
      document.getElementById('asset-title')!.textContent = id === 'private-network' ? 'Choose a network' : 'Choose a token'
      search.value = ''
      search.placeholder = id === 'private-network' ? 'Search networks' : 'Search tokens or paste an address'
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
  const refreshSelection = (event: Event): void => {
    if (event.target instanceof HTMLSelectElement) refreshers.forEach(refresh => refresh())
  }
  document.addEventListener('input', refreshSelection)
  document.addEventListener('change', refreshSelection)
  new MutationObserver(() => refreshers.forEach(refresh => refresh()))
    .observe(document.getElementById('ready-actions')!, { attributes: true, attributeFilter: ['disabled'] })
  return () => refreshers.forEach(refresh => refresh())
}
