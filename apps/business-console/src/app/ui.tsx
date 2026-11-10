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

export function Icon({ name, size }: { name: string; size?: 16 | 20 }) {
  return <svg className={size ? `ic ic-${size}` : 'ic'} aria-hidden="true"><use href={`#i-${name}`} /></svg>
}
export const Tile = ({ name }: { name: string }) => <span className="ic-tile"><Icon name={name} size={20} /></span>

// Status badges of the mockup: one tone and one icon per word.
const STATUS: Record<string, [tone: string, icon: string]> = {
  Active: ['ok', 'check'], 'In place today': ['ok', 'check'], 'This session': ['ok', 'circle-check'],
  Pending: ['warn', 'clock'], Invited: ['warn', 'clock'],
  Suspended: ['draft', 'history'], Planned: ['draft', 'calendar'], Later: ['draft', 'calendar'],
  Revoked: ['bad', 'x'], Frozen: ['bad', 'ban'], Removed: ['bad', 'x'],
}
export function Status({ children }: { children: string }) {
  const [tone, icon] = STATUS[children] ?? ['', 'circle-check']
  return <span className={`badge bi ${tone}`}><Icon name={icon} size={16} />{children}</span>
}

export const stamp = (time: number) => `${new Date(time).toISOString().slice(0, 19).replace('T', ' ')}Z`
export const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)
export const ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin', trader: 'Trader', approver: 'Approver', compliance: 'Compliance officer', viewer: 'Viewer' }

export function Section({ icon, title, hint, later, children }: { icon: string; title: string; hint?: string; later?: boolean; children?: ReactNode }) {
  const head = (
    <header className="sh">
      <Tile name={icon} />
      <div className="tt"><h2 className={later ? 'h-card' : 'h-panel'}>{title}</h2>{hint && <p>{hint}</p>}</div>
      {later && <Status>Later</Status>}
    </header>
  )
  return later ? <section className="panel sec">{head}</section> : <section className="sec">{head}{children}</section>
}
