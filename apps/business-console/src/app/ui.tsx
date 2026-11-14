// Shared pieces: the API call, icons from the sprite inlined in index.html, badges, time.
import type { ReactNode } from 'react'

/** GET without a body, JSON POST with one; bytes (a file sealed in this browser, milestone 5b) go as they are. Same-origin only; the session cookie is HttpOnly. status 0 = no answer. */
export async function api<T = Record<string, never>>(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  try {
    const bytes = body instanceof Uint8Array
    const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { ...headers, 'content-type': bytes ? 'application/octet-stream' : 'application/json' }, body: bytes ? (body as BodyInit) : JSON.stringify(body) })
    return { status: response.status, data: (await response.json().catch(() => ({}))) as T }
  } catch {
    return { status: 0, data: {} as T }
  }
}

/** A passkey check: options from the server, the passkey from the browser, the answer back. Throws if the member cancels. */
export async function passkeyCheck<T = Record<string, never>>(start: string, finish: string, extra: object = {}): Promise<{ status: number; data: T }> {
  const begun = await api<{ options: PublicKeyCredentialRequestOptionsJSON }>(start, {})
  if (begun.status !== 200) return begun as { status: number; data: T }
  const passkey = (await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(begun.data.options) })) as PublicKeyCredential
  return api<T>(finish, { ...extra, response: passkey.toJSON() })
}
/** A sensitive call. When the server asks for a fresh passkey check (5 minutes), do one and try once more. */
export async function sensitive<T = Record<string, never>>(path: string, body: unknown = {}, headers?: Record<string, string>): Promise<{ status: number; data: T & { error?: string } }> {
  const first = await api<T & { error?: string }>(path, body, headers)
  if (first.status !== 403 || first.data.error !== 'step_up_required') return first
  const check = await passkeyCheck<T & { error?: string }>('/api/stepup/start', '/api/stepup/finish')
  return check.status === 200 ? api(path, body, headers) : check
}
// What the server's refusals mean, in the member's words.
const SAY: Record<string, string> = {
  second_key_required: 'Add your second passkey first. Until then this seat cannot do this.',
  step_up_required: 'A passkey check is needed first. Try again.',
  passkey_rejected: 'The passkey check did not pass. Use an active passkey of your own seat.',
  quarantine: 'Your seat is in quarantine after a re-enrolment. This is blocked until it ends.',
  requester_quarantine: 'The member who asked for this is in quarantine after a re-enrolment. It can be approved when the quarantine ends. Until then that member can cancel it.',
  seat_in_quarantine: 'That seat was re-enrolled and is still in quarantine. Its role can change when quarantine ends.',
  forbidden: 'Your role cannot do this.',
  ticket_limit: 'Three links for one member in 24 hours is the limit. Another Owner or Admin can issue one.',
  not_found: 'This is no longer open. Reload the page.',
  try_again: 'Something else changed at the same moment. Try again.',
  device_bound_required: 'This role needs a hardware security key. A passkey that syncs to a cloud account is not accepted.',
  label_invalid: 'Give the key a short name: letters, digits and spaces, 40 characters at most.',
  not_stored: 'The passkey was not stored. It may already be on this seat.',
  last_passkey: 'This is the last passkey of the seat and cannot be revoked. Add another first. In an emergency, freeze the seat.',
  label_taken: 'This seat already has a passkey with that name. Choose another name.',
  last_owner: 'This is the last active Owner. An organisation always keeps one.',
  already_requested: 'This change already waits for a second person, under Approvals.',
  own_request: 'You asked for this change. A different member with a key role approves or rejects it.',
  too_early: 'This lowers a security setting. It can be approved 24 hours after it was asked.',
  invalid: 'Check the name and the role.',
  chain_invalid: 'Choose one of the listed chains.',
  address_invalid: 'This is not a wallet address. Paste all 42 characters. If it mixes upper and lower case, one character is wrong.',
  already_linked: 'This wallet is already linked to the organisation, or waits for its approval.',
  wallet_listed: 'The address of this wallet is on a public sanctions list that Ophis loaded. It cannot be linked. The attempt is recorded.',
  recovery_wallet: 'This is the recovery wallet. It is replaced first, by two people and 72 hours. Then it can be unlinked.',
  single_key: 'A wallet with a single key can be the recovery wallet only in an organisation with one key-role member. Use a Safe or a custodian wallet.',
  change_waiting: 'Another change of recovery wallet waits for its 72 hours. An Owner cancels it first.',
  // Demo mode: the desk.
  institution_only: 'The desk is for institutions.',
  type_invalid: 'Choose market or limit.',
  asset_not_permitted: 'Choose two of the permitted assets.',
  same_asset: 'Choose two different assets.',
  chain_not_allowed: 'Choose Optimism or Unichain.',
  wallet_not_linked: 'That wallet is not linked to this organisation any more. Choose a linked wallet.',
  amount_invalid: 'Enter the amount as a plain number above zero, like 250000 or 1250.50, with no more decimals than the asset has.',
  limit_price_invalid: 'Enter the limit price in EUR as a plain number above zero, with at most 6 decimals.',
  limit_out_of_band: 'The limit price is outside the allowed range: within 20% of the reference price, on both sides.',
  wallet_chain: 'That wallet is not linked on the chain of this order. Choose the chain of the wallet, or a wallet linked on that chain.',
  over_limit: 'This is above the limit of 5,000,000.00 EUR per order, at the reference price or at the limit price.',
  order_rate: 'You prepared 30 orders in the last hour. Try again later.',
  too_many_orders: 'Twenty orders already wait for approval. One of them is decided or cancelled first.',
  org_inactive: 'The organisation is not active.',
  wallet_unreadable: 'The Safe could not be read on both network endpoints just now. Try again in a minute.',
}
export const say = (data: { error?: string }) => SAY[data.error ?? ''] ?? 'That did not work. Reload the page and try again.'
export const CANCELLED = 'The passkey request was cancelled or timed out. Try again.'

export function Icon({ name, size }: { name: string; size?: 16 | 20 }) {
  return <svg className={size ? `ic ic-${size}` : 'ic'} aria-hidden="true"><use href={`#i-${name}`} /></svg>
}
export const Tile = ({ name }: { name: string }) => <span className="ic-tile"><Icon name={name} size={20} /></span>

// Status badges of the mockup: one tone and one icon per word.
const STATUS: Record<string, [tone: string, icon: string]> = {
  Active: ['ok', 'check'], 'In place today': ['ok', 'check'], 'This session': ['ok', 'circle-check'], Done: ['ok', 'check'],
  Pending: ['warn', 'clock'], Invited: ['warn', 'clock'], Linked: ['ok', 'check'],
  Ready: ['ok', 'shield-check'], 'At risk': ['warn', 'triangle-alert'], 'Not recoverable': ['bad', 'triangle-alert'],
  Green: ['ok', 'check'], Amber: ['warn', 'triangle-alert'], Red: ['bad', 'x'], None: ['bad', 'x'],
  Suspended: ['draft', 'history'], Planned: ['draft', 'calendar'], Later: ['draft', 'calendar'],
  // Demo mode: the states of an order, and the tags of example rows.
  'Pending approval': ['warn', 'clock'], 'Approved. Not sent: demo': ['ok', 'check'], Refused: ['bad', 'x'], Cancelled: ['draft', 'ban'], Expired: ['draft', 'history'],
  Open: ['', 'clock'], Filled: ['ok', 'check'], Paid: ['ok', 'check'], Carried: ['', 'clock'], 'Waiting for signatures': ['warn', 'clock'], 'Not sent yet': ['draft', 'clock'], Example: ['draft', 'info'], Illustrative: ['preview', 'info'], Demo: ['preview', 'info'],
  Revoked: ['bad', 'x'], Frozen: ['bad', 'ban'], Removed: ['bad', 'x'], 'Chain verified': ['ok', 'shield-check'], 'Chain broken': ['bad', 'triangle-alert'],
}
export function Status({ children }: { children: string }) {
  const [tone, icon] = STATUS[children] ?? ['', 'circle-check']
  return <span className={`badge bi ${tone}`}><Icon name={icon} size={16} />{children}</span>
}

/** Hands a file the server built to the browser's download. */
export function save(name: string, text: string, type = 'text/csv') {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([text], { type }))
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}
export const stamp = (time: number) => `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')}Z`
/** A date, UTC: 2027-11-11. */
export const day = (time: number) => new Date(time).toISOString().slice(0, 10)
// A deadline: UTC, as everywhere in the console, and the reader's own clock next to it when the two differ.
export function minute(time: number) {
  const utc = new Date(time).toISOString().slice(0, 16).replace('T', ' ')
  const local = new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${utc} UTC${local === utc.slice(11) ? '' : ` (${local} your time)`}`
}
export const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
export const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', trader: 'Trader', approver: 'Approver', compliance: 'Compliance officer', viewer: 'Viewer' }

export function Section({ id, icon, title, hint, later, action, children }: { id?: string; icon: string; title: string; hint?: string; later?: boolean; action?: ReactNode; children?: ReactNode }) {
  const head = (
    <header className="sh">
      <Tile name={icon} />
      <div className="tt"><h2 className={later ? 'h-card' : 'h-panel'}>{title}</h2>{hint && <p>{hint}</p>}</div>
      {later ? <Status>Later</Status> : action}
    </header>
  )
  return later ? <section className="panel sec">{head}</section> : <section className="sec" id={id}>{head}{children}</section>
}
