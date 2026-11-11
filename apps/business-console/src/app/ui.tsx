// Shared pieces: the API call, icons from the sprite inlined in index.html, badges, time.
import type { ReactNode } from 'react'

/** GET without a body, JSON POST with one. Same-origin only; the session cookie is HttpOnly. status 0 = no answer. */
export async function api<T = Record<string, never>>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  try {
    const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
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
export async function sensitive<T = Record<string, never>>(path: string, body: unknown = {}): Promise<{ status: number; data: T & { error?: string } }> {
  const first = await api<T & { error?: string }>(path, body)
  if (first.status !== 403 || first.data.error !== 'step_up_required') return first
  const check = await passkeyCheck<T & { error?: string }>('/api/stepup/start', '/api/stepup/finish')
  return check.status === 200 ? api(path, body) : check
}
// What the server's refusals mean, in the member's words.
const SAY: Record<string, string> = {
  second_key_required: 'Add your second passkey first. Until then this seat cannot do this.',
  step_up_required: 'A passkey check is needed first. Try again.',
  passkey_rejected: 'The passkey check did not pass. Use an active passkey of your own seat.',
  quarantine: 'Your seat is in quarantine after a re-enrolment. This is blocked until it ends.',
  forbidden: 'Your role cannot do this.',
  ticket_limit: 'Three links for one member in 24 hours is the limit. Another Owner or Admin can issue one.',
  not_found: 'This is no longer open. Reload the page.',
  words_invalid: 'Type the three words exactly as you heard them. One of them is not a word of the list.',
  ticket_dead: 'Three wrong tries. The link and the pending passkey are cancelled. Start again with a new link.',
  try_again: 'Something else changed at the same moment. Try again.',
  device_bound_required: 'This role needs a hardware security key. A passkey that syncs to a cloud account is not accepted.',
  label_invalid: 'Give the key a short name: letters, digits and spaces, 40 characters at most.',
  not_stored: 'The passkey was not stored. It may already be on this seat.',
  last_passkey: 'This is the last passkey of the seat. Add another first.',
  invalid: 'Check the name and the role.',
}
export const say = (data: { error?: string; left?: number }) =>
  data.error === 'wrong_words' ? `Those are not the words. ${data.left === 1 ? 'One try' : `${data.left} tries`} left.`
  : SAY[data.error ?? ''] ?? 'That did not work. Reload the page and try again.'
export const CANCELLED = 'The passkey request was cancelled or timed out. Try again.'

export function Icon({ name, size }: { name: string; size?: 16 | 20 }) {
  return <svg className={size ? `ic ic-${size}` : 'ic'} aria-hidden="true"><use href={`#i-${name}`} /></svg>
}
export const Tile = ({ name }: { name: string }) => <span className="ic-tile"><Icon name={name} size={20} /></span>

// Status badges of the mockup: one tone and one icon per word.
const STATUS: Record<string, [tone: string, icon: string]> = {
  Active: ['ok', 'check'], 'In place today': ['ok', 'check'], 'This session': ['ok', 'circle-check'], Done: ['ok', 'check'],
  Pending: ['warn', 'clock'], Invited: ['warn', 'clock'],
  Suspended: ['draft', 'history'], Planned: ['draft', 'calendar'], Later: ['draft', 'calendar'],
  Revoked: ['bad', 'x'], Frozen: ['bad', 'ban'], Removed: ['bad', 'x'],
}
export function Status({ children }: { children: string }) {
  const [tone, icon] = STATUS[children] ?? ['', 'circle-check']
  return <span className={`badge bi ${tone}`}><Icon name={icon} size={16} />{children}</span>
}

export const stamp = (time: number) => `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')}Z`
export const minute = (time: number) => `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
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
