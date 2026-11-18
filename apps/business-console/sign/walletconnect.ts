// WalletConnect for the signing page (owner, 2026-11-18): a wallet on a phone, or any wallet that speaks WalletConnect,
// signs a request opened on this computer. It is the same Provider as a browser wallet's, for the calls the proof route
// makes: the account, the chain, and one EIP-712 signature. Loaded only when chosen. The page's policy names the relay
// and the Verify service (which lets the wallet show this page's own address); telemetry is off.
import SignClient from '@walletconnect/sign-client'
import QRCode from 'qrcode'

const PROJECT_ID = '22b04d22ab97e563062ce2228546286f' // Ophis's WalletConnect project, also the CLI's (packages/cli/src/phone.ts)
const SVG = 'http://www.w3.org/2000/svg'

/** The pairing link as an SVG QR code, drawn from its modules: no data: URL, no markup string. */
export function qr(uri: string): SVGSVGElement {
  const { modules } = QRCode.create(uri, { errorCorrectionLevel: 'M' })
  const size = modules.size + 8 // 4 modules of quiet zone on each side
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`)
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', 'WalletConnect QR code')
  const back = document.createElementNS(SVG, 'rect')
  back.setAttribute('width', String(size))
  back.setAttribute('height', String(size))
  back.setAttribute('fill', '#fff')
  let d = ''
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`
  const dots = document.createElementNS(SVG, 'path')
  dots.setAttribute('d', d)
  dots.setAttribute('fill', '#000')
  svg.append(back, dots)
  return svg
}

/**
 * A Provider over one WalletConnect session for `chainId`. `eth_requestAccounts` pairs: `pairing(uri)` shows the link
 * until the wallet approves. The other calls answer from the session, and the signature goes to the wallet.
 */
export function walletConnect(chainId: number, pairing: (uri: string | null) => void) {
  const chain = `eip155:${chainId}`
  let client: SignClient | undefined
  let topic = ''
  let account = ''
  return {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      if (method === 'eth_requestAccounts') {
        client ??= await SignClient.init({
          projectId: PROJECT_ID,
          telemetryEnabled: false,
          metadata: { name: 'Ophis Business', description: 'Wallet signature for the Ophis Business console', url: location.origin, icons: [`${location.origin}/sign/icon.svg`] },
        })
        const { uri, approval } = await client.connect({ optionalNamespaces: { eip155: { chains: [chain], methods: ['eth_signTypedData_v4'], events: ['accountsChanged', 'chainChanged'] } } })
        if (uri) pairing(uri)
        try {
          const session = await approval()
          topic = session.topic
          // "eip155:10:0xabc…": the account the wallet gave for the chain the request names, and no other.
          account = (session.namespaces.eip155?.accounts ?? []).find((a) => a.startsWith(`${chain}:`))?.slice(chain.length + 1) ?? ''
        } finally {
          pairing(null)
        }
        if (!account) throw new Error('chain')
        return [account]
      }
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`
      if (method === 'wallet_switchEthereumChain') {
        const [{ chainId: asked }] = params as [{ chainId: string }]
        if (Number(asked) !== chainId) throw new Error('chain')
        return null
      }
      if (method === 'eth_signTypedData_v4' && client && topic) return client.request({ topic, chainId: chain, request: { method, params: params ?? [] } })
      throw new Error(`unsupported: ${method}`)
    },
  }
}
