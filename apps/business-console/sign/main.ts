// The signing page, on its own hostname. It reads a request (the text a manager got in the console, or a requester
// on the console's recovery page), shows what will be signed, asks the wallet for one EIP-712 signature and posts it
// to the proof route of this host. A wallet link names its wallet and chain. A recovery request does not: the
// server tells nobody which wallet is an organisation's recovery wallet, so the wallet that signs fills them in.
// It holds no session and calls nothing else. Wallet code lives here and on the server, never in the console.
// The real desk: a link "#order.<token>" opens an approved order. The server builds everything from the approved terms:
// the page never chooses an amount, a token, a receiver or a chain. It only asks the wallet.
import SafeAppsSDK from '@safe-global/safe-apps-sdk'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import '../src/app/fonts.css' // Inter, copied by this build into /sign/assets/: the page's policy has font-src 'self'
import '../src/app/kit.css'
import '../src/app/app.css'
import './sign.css'
import { CHAIN_NAME, PROOF_ACTION, typedLink, typedProof, type ProofKind, type Typed } from '../src/server/typed.ts'

interface Request { org: string; chainId: number; wallet: string; nonce: string; issuedAt: number; expiresAt: number; site: string; kind?: ProofKind; credentialHash?: string }
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
  wallet_listed: 'The address of this wallet is on a public sanctions list that Ophis loaded. It cannot be linked. The attempt is recorded.',
  forbidden: 'The member who asked for this link can no longer link wallets. Ask an Owner or Admin for a new link.',
  quarantine: 'The member who asked for this link is in quarantine, or the whole organisation is after an account recovery. Try again when it ends.',
  waiting: 'Signed and checked. The request now waits 72 hours, and every member of the organisation sees it when they sign in. After the wait the requester continues on the recovery page of the console.',
  cancelled: 'Signed and checked. The account recovery is cancelled. Nothing was changed.',
  proof_rejected: 'Refused. Either the signature is not valid, or this wallet on this chain is not the recovery wallet in force of that organisation, or a request is already open, or one was cancelled less than 24 hours ago, or this request was used before. For a Safe, enough owners must have signed.',
  too_many: 'Too many checks for this organisation in the last hour. Try again in an hour.',
  request_open: 'Another recovery request of this organisation is open. It is cancelled or completed first.',
  wait_after_cancel: 'A recovery request was cancelled less than 24 hours ago. Try again later.',
  override_refused: 'An override is possible only when the recovery wallet is a Safe with two or more signers, no module and unchanged owners, and only within 30 days of an Owner cancelling or stopping a recovery. Start a normal recovery instead.',
  single_key: 'A wallet with a single key restores access only for an organisation of one person.',
  wallet_unreadable: 'The Safe could not be read on both network endpoints just now. Try again in a minute.',
  no_recovery_wallet: 'This organisation has no recovery wallet in force.',
  stored: 'Signed and checked. The wallet is stored as the recovery wallet this organisation named. It is in force once Ophis has approved the organisation. You can close this page.',
  not_unverified: 'This organisation is no longer waiting for its activation. Nothing was stored.',
  first_passkey_gone: 'The passkey this request confirms is no longer active. Ask the Owner for a new link.',
}
const TITLE: Record<string, [plain: string, emphasised: string, lede: string]> = {
  replace: ['Restore access ', 'to an organisation', 'Someone asks the recovery wallet of an organisation to replace all its Owner passkeys with a new one. If you sign, a wait of 72 hours starts, and then that person is an Owner. Sign only if the request comes from your colleague by a channel you trust, and the organisation id matches the recovery sheet.'],
  override: ['Restore access, ', 'overriding the Owners', 'Someone asks the recovery wallet of an organisation to replace all its Owner passkeys, against its Owners: they cannot cancel or stop it. Sign only if the signers of this wallet decided so together, the request comes from your colleague by a channel you trust, and the organisation id matches the recovery sheet.'],
  activate: ['Activate ', 'a new organisation', 'A new organisation names this wallet as its recovery wallet, and asks it to confirm the passkey of its first Owner. Sign only if the request comes from the Owner by a channel you trust, and the organisation id matches what the Owner shows you. Later this wallet can restore access to the organisation.'],
  cancel: ['Cancel ', 'an account recovery', 'This cancels the account recovery with the request number below. Nothing else changes, and a new request can start 24 hours later.'],
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
/** The request names its wallet and chain (a link, an activation). A recovery does not: the wallet that signs fills them in. */
const named = () => request.kind === undefined || request.kind === 'activate'

// The request is base64url(JSON) "." MAC. The page shows the fields; only the server can check the MAC, and it does.
function read(code: string) {
  const ordered = /^(?:.*#)?order\.([A-Za-z0-9_-]{43})$/.exec(code.trim())
  if (ordered) return void readOrder(ordered[1])
  try {
    sealed = code.trim().replace(/^.*#/, '')
    request = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(sealed.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as Request
    // An activation (milestone 5) is a Proof that names its wallet and chain, as a link does.
    const recovery = request.kind !== undefined && request.kind !== 'activate'
    if (request.kind !== undefined && (!Object.hasOwn(PROOF_ACTION, request.kind!) || typeof request.credentialHash !== 'string')) throw new Error('fields')
    if (![request.org, request.nonce, request.site, ...(recovery ? [] : [request.wallet])].every((value) => typeof value === 'string') || ![request.issuedAt, request.expiresAt, ...(recovery ? [] : [request.chainId])].every(Number.isSafeInteger)) throw new Error('fields')
  } catch {
    $('request').hidden = true
    return say('This is not a request code. Copy the whole link from the console and paste it here.', 'bad')
  }
  const kind = request.kind
  document.querySelector('.sign')!.classList.toggle('recovery', kind !== undefined)
  if (kind) {
    // Text, never markup: the emphasised part of the title is an element made here, and every field is set as text.
    $('title').replaceChildren(TITLE[kind][0], Object.assign(document.createElement('em'), { textContent: TITLE[kind][1] }), '.')
    $('lede').textContent = TITLE[kind][2]
    $('advice').textContent = kind === 'activate' ? 'Your wallet shows the same fields. Sign only if the request comes from your colleague by a channel you trust, and the organisation named is theirs.'
      : 'Your wallet shows the same fields. The wallet and the chain are those of the wallet that signs: it must be the recovery wallet, on the chain named on the recovery sheet.'
    // G7: an activation confirms the passkey the first Owner already holds; a recovery names a new one; a cancel, none.
    $('l-passkey').textContent = kind === 'activate' ? 'First Owner passkey (hash)' : kind === 'cancel' ? 'Passkey (none: a cancellation names no passkey)' : 'New passkey (hash)'
    $('f-passkey').textContent = request.credentialHash!
    $('f-nonce').textContent = request.nonce
  }
  show(named() ? { wallet: request.wallet, chainId: request.chainId } : null)
  $('f-action').textContent = kind ? PROOF_ACTION[kind] : String(typed.message.action)
  $('f-site').textContent = request.site
  $('f-org').textContent = request.org
  $('f-expires').textContent = `${new Date(request.expiresAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  $('by-safe').hidden = !safe
  $('by-wallet').hidden = Boolean(safe)
  $('status').hidden = true
  $('request').hidden = false
  $('paste').hidden = true
}

// The typed data, once the wallet and the chain are known: from the request (a link), or from the wallet that signs (a recovery).
function show(by: { wallet: string; chainId: number } | null) {
  $('f-chain').textContent = by ? `${CHAIN_NAME[by.chainId] ?? 'Unknown chain'} (chain id ${by.chainId})` : 'The chain of the wallet that signs'
  $('f-wallet').textContent = by ? by.wallet : 'The wallet that signs'
  if (!by) return
  const fields = { chainId: by.chainId, site: request.site, organisationId: request.org, wallet: by.wallet, nonce: request.nonce, issuedAt: request.issuedAt, expiresAt: request.expiresAt }
  typed = request.kind ? typedProof({ ...fields, kind: request.kind, credentialHash: request.credentialHash! }) : typedLink(fields)
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
  if (!named()) show({ wallet: account, chainId: Number(await ethereum.request({ method: 'eth_chainId' })) })
  else {
    if (!same(account, request.wallet)) return say(`The wallet in this browser is ${account}. The request is for ${request.wallet}. Switch the account and try again.`, 'bad')
    await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${request.chainId.toString(16)}` }] })
  }
  await post((await ethereum.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(typed)] })) as string)
}

// Route B: inside the Safe interface. Offchain signing is asked for; a Safe set to sign onchain sends a transaction
// instead, and "Check again" asks the server to read the Safe once it is executed.
async function bySafe() {
  const info = await safe!.safe.getInfo()
  if (!named()) show({ wallet: info.safeAddress, chainId: info.chainId })
  else if (!same(info.safeAddress, request.wallet) || info.chainId !== request.chainId) return say(`This Safe is ${info.safeAddress} on chain ${info.chainId}. The request is for ${request.wallet} on chain ${request.chainId}. Open the right Safe and try again.`, 'bad')
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

// ---- the real desk: an approved order to sign, or an open one to cancel ----
interface OrderPage { purpose: 'sign' | 'cancel'; scheme: 'eip712' | 'presign'; chainId: number; wallet: string; words: Record<string, string>; uid: string; settlement: string; relayer: string; sellToken: string; sellAmount: string; typed: Typed | null }
const ORDER_SAY: Record<string, string> = {
  open: 'Signed and sent. The order is open on the orderbook until it fills or expires. You can close this page.',
  presignaturePending: 'Sent. The order waits for the Safe owners to execute the transaction in the Safe interface. Once it is executed, the order is open.',
  cancelled: 'Signed and sent. The orderbook cancelled the order. You can close this page.',
  asked: 'The cancel waits for the Safe owners to execute the transaction in the Safe interface.',
  link_invalid: 'This link is not valid any more: it was used, it expired, or a newer link replaced it. Ask for a new link in the console.',
  signature_rejected: 'The signature is not from the wallet of this order. Nothing was sent.',
  sanctioned_address: 'Refused: an address of this order is on a public sanctions list that Ophis loaded. Nothing was sent. The attempt is recorded.',
  wallet_not_linked: 'The wallet is no longer linked to the organisation on this chain. Nothing was sent.',
  order_refused: 'The orderbook refused the order. Nothing was sent.',
  orderbook_unavailable: 'The orderbook did not answer. Try again in a minute.',
  already_sent: 'This order was already sent.',
  not_opened: 'Reload this page, then sign.',
  try_again: 'Something else changed at the same moment. Reload this page and try again.',
}
const ERC20 = parseAbi(['function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)'])
const SETTLEMENT = parseAbi(['function setPreSignature(bytes orderUid, bool signed)'])
let token = ''
let order: OrderPage
const call = async (path: string, body: object) => {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, ...body }) }).catch(() => null)
  return { ok: response?.status === 200, data: ((await response?.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}
async function readOrder(code: string) {
  token = code
  const { ok, data } = await call('/api/order', {})
  $('paste').hidden = true
  if (!ok) return say(ORDER_SAY[data.error as string] ?? 'The order could not be read. Try again in a minute.', 'bad')
  order = data as unknown as OrderPage
  const w = order.words
  // Text, never markup: every field is set as text.
  $('title').replaceChildren(order.purpose === 'sign' ? 'Sign ' : 'Cancel ', Object.assign(document.createElement('em'), { textContent: 'an approved order' }), '.')
  $('lede').textContent = order.purpose === 'sign'
    ? 'Two people in the organisation approved this order. If you sign, it goes to the public orderbook and can fill until it expires. What is bought goes to the wallet itself. Ophis never holds the funds.'
    : 'This cancels the open order below. Nothing else changes.'
  for (const [id, text] of [['o-sell', w.sell], ['o-buy', w.buy], ['o-type', w.type], ['o-chain', w.chain], ['o-wallet', w.wallet], ['o-valid', w.valid], ['o-fee', w.fee], ['o-uid', order.uid]]) $(id).textContent = text
  $('o-advice').textContent = order.scheme === 'presign'
    ? 'In the Safe interface you see one transaction batch: an approval of exactly the amount sold to the CoW Protocol vault relayer if one is needed, and the signature of this order on the settlement contract. Check it before the owners sign.'
    : 'Your wallet may first ask to approve exactly the amount sold to the CoW Protocol vault relayer, then it shows the order to sign. Check that it matches.'
  $('o-by-wallet').hidden = Boolean(safe)
  $('o-by-safe').hidden = !safe
  $('o-by-wallet').textContent = $('o-by-safe').textContent = order.purpose === 'sign' ? (safe ? 'Sign with this Safe' : 'Sign with the wallet in this browser') : (safe ? 'Cancel with this Safe' : 'Cancel with the wallet in this browser')
  $('order').hidden = false
}
const sent = async (signature?: string) => {
  say('Sending.')
  const { data } = await call('/api/order/send', signature ? { signature } : {})
  say(ORDER_SAY[(data.state ?? data.error) as string] ?? 'The order could not be sent. Try again in a minute.', data.state ? 'ok' : 'bad')
}
const short = (have: unknown) => BigInt(decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: have as `0x${string}` })) < BigInt(order.sellAmount)
const approval = () => encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [order.relayer as `0x${string}`, BigInt(order.sellAmount)] })
const allowance = () => encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [order.wallet as `0x${string}`, order.relayer as `0x${string}`] })
const presign = (signed: boolean) => encodeFunctionData({ abi: SETTLEMENT, functionName: 'setPreSignature', args: [order.uid as `0x${string}`, signed] })

// A key wallet in this browser: the chain, the allowance (an approval of the exact amount if short, and its receipt), the signature.
async function orderByWallet() {
  const { ethereum } = window as { ethereum?: Provider }
  if (!ethereum) return say('No wallet was found in this browser. Open this page in the browser that holds the wallet.', 'warn')
  const [account] = (await ethereum.request({ method: 'eth_requestAccounts' })) as string[]
  if (!same(account, order.wallet)) return say(`The wallet in this browser is ${account}. The order is for ${order.wallet}. Switch the account and try again.`, 'bad')
  await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${order.chainId.toString(16)}` }] })
  if (order.purpose === 'sign' && short(await ethereum.request({ method: 'eth_call', params: [{ to: order.sellToken, data: allowance() }, 'latest'] }))) {
    say('Approve exactly the amount sold, in the wallet. Then wait for the transaction.')
    const hash = await ethereum.request({ method: 'eth_sendTransaction', params: [{ from: account, to: order.sellToken, data: approval() }] })
    for (let receipt: { status?: string } | null = null; ; await new Promise((resolve) => setTimeout(resolve, 2000))) {
      receipt = (await ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status?: string } | null
      if (receipt?.status === '0x1') break
      if (receipt) return say('The approval failed onchain. Nothing was signed.', 'bad')
    }
  }
  await sent((await ethereum.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(order.typed)] })) as string)
}
// Inside the Safe interface: one batch, which its owners sign and execute there. Signing: [approve the exact amount if short,
// setPreSignature(order, true)]. Cancelling: setPreSignature(order, false).
async function orderBySafe() {
  const info = await safe!.safe.getInfo()
  if (!same(info.safeAddress, order.wallet) || info.chainId !== order.chainId) return say(`This Safe is ${info.safeAddress} on chain ${info.chainId}. The order is for ${order.wallet} on chain ${order.chainId}. Open the right Safe and try again.`, 'bad')
  const txs = order.purpose === 'cancel' ? [] : (short(await safe!.eth.call([{ from: order.wallet, to: order.sellToken, data: allowance() }])) ? [{ to: order.sellToken, value: '0', data: approval() }] : [])
  await safe!.txs.send({ txs: [...txs, { to: order.settlement, value: '0', data: presign(order.purpose === 'sign') }] })
  await sent()
}
$('o-by-wallet').addEventListener('click', () => void orderByWallet().catch(() => say('The wallet did not sign. Nothing was sent.', 'warn')))
$('o-by-safe').addEventListener('click', () => void orderBySafe().catch(() => say('The Safe did not take the transaction. Nothing was sent.', 'warn')))

const run = (action: () => Promise<unknown>) => () => void action().catch(() => say('The wallet did not sign. Nothing was sent.', 'warn'))
$('paste').addEventListener('submit', (event) => {
  event.preventDefault()
  read(($('code') as HTMLTextAreaElement).value)
})
$('by-wallet').addEventListener('click', run(byWallet))
$('by-safe').addEventListener('click', run(bySafe))
// "Check again" sends no signature: for a recovery inside the Safe interface, the Safe that is open is the wallet meant.
$('check').addEventListener('click', run(() => post('0x')))
if (location.hash.length > 1) read(location.hash.slice(1))
