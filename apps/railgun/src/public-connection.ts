import type EthereumProvider from '@walletconnect/ethereum-provider'
import type { Eip1193Provider } from 'ethers'
import { element } from './ui'
import { ENVIRONMENT } from './config'

type WalletEvent = 'accountsChanged' | 'chainChanged' | 'disconnect'
export type PublicWalletProvider = Eip1193Provider & {
  on?: (event: WalletEvent, listener: () => void) => unknown
  removeListener?: (event: WalletEvent, listener: () => void) => unknown
  disconnect?: () => Promise<void>
}

declare global {
  interface Window {
    ethereum?: PublicWalletProvider
  }
}

let walletConnect: Promise<EthereumProvider> | undefined
const STORAGE_PREFIX = 'ophis-walletconnect-storage-prefix'
let pendingStoragePrefix: string | undefined

function saveStoragePrefix(): void {
  if (!pendingStoragePrefix) return
  try {
    localStorage.setItem(STORAGE_PREFIX, pendingStoragePrefix)
    pendingStoragePrefix = undefined
  } catch {
    throw new Error('WalletConnect needs browser storage before reconnecting.')
  }
}

export async function connectPublicWallet(kind: 'browser' | 'walletconnect'): Promise<PublicWalletProvider> {
  if (kind === 'browser') {
    if (!window.ethereum) throw new Error('No browser wallet found. Use WalletConnect to connect your mobile wallet.')
    return window.ethereum
  }
  if (ENVIRONMENT === 'fork')
    throw new Error('WalletConnect is unavailable in fork mode. Use a dedicated browser test wallet on the local fork.')
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim()
  if (!projectId) throw new Error('WalletConnect is not configured on this installation.')
  saveStoragePrefix()
  walletConnect ??= import('@walletconnect/ethereum-provider')
    .then(({ EthereumProvider }) => EthereumProvider.init({
      projectId,
      optionalChains: [1],
      optionalMethods: ['eth_sendTransaction', 'wallet_switchEthereumChain'],
      optionalEvents: ['chainChanged', 'accountsChanged'],
      rpcMap: { 1: new URL('/rpc', location.origin).href },
      disableProviderPing: true,
      telemetryEnabled: false,
      customStoragePrefix: localStorage.getItem(STORAGE_PREFIX) || 'ophis-public-wallet',
      // The SDK's full modal enables analytics; render only the pairing QR here.
      showQrModal: false,
      metadata: {
        name: 'Ophis Private Wallet',
        description: 'Shield funds with RAILGUN.',
        url: location.origin,
        icons: [],
      },
    }))
    .catch((error: unknown) => {
      walletConnect = undefined
      throw error
    })
  const provider = await walletConnect
  if (provider.session) return provider
  const dialog = element<HTMLDialogElement>('walletconnect-dialog')
  const qr = element<HTMLImageElement>('walletconnect-qr')
  const link = element<HTMLInputElement>('walletconnect-link')
  const { default: qrcode } = await import('qrcode-generator')
  const display = (uri: string): void => {
    const code = qrcode(0, 'M')
    code.addData(uri)
    code.make()
    qr.src = code.createDataURL(5, 20)
    link.value = uri
    if (!dialog.open) dialog.showModal()
  }
  let cancel: (() => void) | undefined
  let wasCancelled = false
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => {
      // An in-flight approval can finish after cancellation; isolate the next session's storage.
      wasCancelled = true
      walletConnect = undefined
      pendingStoragePrefix = `ophis-public-wallet-${crypto.randomUUID()}`
      let message = 'WalletConnect connection cancelled. You can try again.'
      try { saveStoragePrefix() } catch { message = 'WalletConnect connection cancelled. Allow browser storage before reconnecting.' }
      void provider.signer.cleanupPendingPairings({ deletePairings: true })
      reject(new Error(message))
    }
  })
  element<HTMLButtonElement>('walletconnect-cancel').onclick = () => cancel?.()
  dialog.oncancel = (event) => { event.preventDefault(); cancel?.() }
  element<HTMLButtonElement>('walletconnect-copy').onclick = () => {
    void navigator.clipboard.writeText(link.value).catch(() => {
      element('error').textContent = 'Could not copy the connection link. Select it and copy it manually.'
    })
  }
  provider.on('display_uri', display)
  try {
    const connecting = provider.connect().then(async () => {
      if (wasCancelled) {
        await provider.disconnect()
        throw new Error('Cancelled WalletConnect approval discarded.')
      }
    })
    await Promise.race([connecting, cancelled])
    return provider
  } finally {
    provider.removeListener('display_uri', display)
    dialog.close()
    qr.removeAttribute('src')
    link.value = ''
    dialog.oncancel = null
    element<HTMLButtonElement>('walletconnect-cancel').onclick = null
    element<HTMLButtonElement>('walletconnect-copy').onclick = null
  }
}
