// The signing page, on its own hostname. It reads a request (the text a manager got in the console), shows what
// will be signed, asks the wallet for one EIP-712 signature and posts it to the proof route of this host.
// It holds no session and calls nothing else. Wallet code lives here and on the server, never in the console.
import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import '../src/app/fonts.css' // Inter, copied by this build into /sign/assets/: the page's policy has font-src 'self'
import '../src/app/kit.css'
import '../src/app/app.css'
import './sign.css'
import { CHAIN_NAME, typedLink, type Typed } from '../src/server/typed.ts'

interface Request { org: string; chainId: number; wallet: string; nonce: string; issuedAt: number; expiresAt: number; site: string }
interface Provider { request(call: { method: string; params?: unknown[] }): Promise<unknown> }
const $ = (id: string) => document.getElementById(id)!
const SAY: Record<string, string> = {
  linked: 'Done. The wallet is linked to the organisation. You can close this page.',
  pending: 'Signed and checked. The link now waits for a second person, who approves it in the console under Approvals.',
  intent_invalid: 'This request is not one the console issued, or it was changed on the way. Ask for a new link.',
  intent_expired: 'This request has expired. Ask for a new link in the console.',
  signature_rejected: 'The signature is not valid for this wallet on this chain. For a Safe, enough owners must have signed, and both network endpoints must agree: try again in a minute.',
  signature_invalid: 'The wallet returned something that is not a signature.',
  proof_used: 'This request was already used. Ask for a new link in the console.',
  already_linked: 'This wallet is already linked to the organisation, or waits for its approval.',
  forbidden: 'The member who asked for this link can no longer link wallets. Ask an Owner or Admin for a new link.',
  quarantine: 'The member who asked for this link is in quarantine after a re-enrolment. Try again when it ends.',
}
// Inside the Safe interface the page is framed, and the Safe signs. Outside it, the wallet of this browser does.
const safe = window.parent === window ? null : new SafeAppsSDK()
let sealed = ''
let request: Request
let typed: Typed

function say(text: string, tone: 'info' | 'ok' | 'warn' | 'bad' = 'info') {
  const status = $('status')
  status.textContent = text
  status.className = `note ${tone}`
  status.hidden = false
}
const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

// The request is base64url(JSON) "." MAC. The page shows the fields; only the server can check the MAC, and it does.
function read(code: string) {
  try {
    sealed = code.trim().replace(/^.*#/, '')
    request = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sealed.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as Request
    if (![request.org, request.wallet, request.nonce, request.site].every((value) => typeof value === 'string') || ![request.chainId, request.issuedAt, request.expiresAt].every(Number.isSafeInteger)) throw new Error('fields')
  } catch {
    $('request').hidden = true
    return say('This is not a request code. Copy the whole link from the console and paste it here.', 'bad')
  }
  typed = typedLink({ chainId: request.chainId, site: request.site, organisationId: request.org, wallet: request.wallet, nonce: request.nonce, issuedAt: request.issuedAt, expiresAt: request.expiresAt })
  $('f-action').textContent = String(typed.message.action)
  $('f-site').textContent = request.site
  $('f-org').textContent = request.org
  $('f-chain').textContent = `${CHAIN_NAME[request.chainId] ?? 'Unknown chain'} (chain id ${request.chainId})`
  $('f-wallet').textContent = request.wallet
  $('f-expires').textContent = `${new Date(request.expiresAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  $('by-safe').hidden = !safe
  $('by-wallet').hidden = Boolean(safe)
  $('status').hidden = true
  $('request').hidden = false
  $('paste').hidden = true
}

async function post(signature: string) {
  say('Checking the signature.')
  const response = await fetch('/api/proof', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: sealed, signature }) }).catch(() => null)
  const answer = ((await response?.json().catch(() => null)) ?? {}) as { state?: string; error?: string }
  say(SAY[answer.state ?? answer.error ?? ''] ?? 'The check could not be made. Try again in a minute.', answer.state ? 'ok' : 'bad')
}

// Route A: the wallet this browser holds (an extension, or a custodian's extension).
async function byWallet() {
  const { ethereum } = window as { ethereum?: Provider }
  if (!ethereum) return say('No wallet was found in this browser. Open this page in the browser that holds the wallet, or inside the Safe interface.', 'warn')
  const [account] = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (!same(account, request.wallet)) return say(`The wallet in this browser is ${account}. The request is for ${request.wallet}. Switch the account and try again.`, 'bad')
  await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${request.chainId.toString(16)}` }] })
  await post((await ethereum.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] })) as string)
}

// Route B: inside the Safe interface. Offchain signing is asked for; a Safe set to sign onchain sends a transaction
// instead, and "Check again" asks the server to read the Safe once it is executed.
async function bySafe() {
  const info = await safe!.safe.getInfo()
  if (!same(info.safeAddress, request.wallet) || info.chainId !== request.chainId) return say(`This Safe is ${info.safeAddress} on chain ${info.chainId}. The request is for ${request.wallet} on chain ${request.chainId}. Open the right Safe and try again.`, 'bad')
  await safe!.eth.setSafeSettings([{ offChainSigning: true }])
  const signed = await safe!.txs.signTypedMessage(typed as never)
  if (!('messageHash' in signed)) return say('This Safe signs onchain. Once its owners have executed the transaction, press "Check again".', 'warn')
  say('Waiting for the other owners to sign in the Safe interface. Keep this window open.')
  for (;;) {
    const signature = await safe!.safe.getOffChainSignature(signed.messageHash)
    if (signature) return post(signature)
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

const run = (action: () => Promise<unknown>) => () => void action().catch(() => say('The wallet did not sign. Nothing was sent.', 'warn'))
$('paste').addEventListener('submit', (event) => {
  event.preventDefault()
  read(($('code') as HTMLTextAreaElement).value)
})
$('by-wallet').addEventListener('click', run(byWallet))
$('by-safe').addEventListener('click', run(bySafe))
$('check').addEventListener('click', run(() => post('0x')))
if (location.hash.length > 1) read(location.hash.slice(1))
