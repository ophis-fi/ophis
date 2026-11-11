// Support (milestone 6): a question box, the matching help text, and the hand-over to a person by email.
// Every text shown comes from the server's fixed answer base. Nothing a model wrote is ever displayed.
import { useState, type FormEvent } from 'react'
import { api, Icon, Tile } from './ui.tsx'

interface Entry { id: string; title: string; text: string; link: string }
type View =
  | { kind: 'idle' } | { kind: 'busy' } | { kind: 'empty' } | { kind: 'secret' } | { kind: 'thanks' }
  | { kind: 'answer'; list: Entry[]; at: number }
  | { kind: 'handover'; why: string }

const MAX = 500
const PRIVACY = 'An outside provider, TypeSafe AI (USA), matches your question to our help texts. It receives your question without your name, organisation or wallet. Ophis does not store your question.'
// The notice above is about what Ophis adds. What the member types is sent as typed, less what the cleaning removes.
const CARE = 'Leave out names and anything secret.'
// The email is the member's own: a subject and three empty lines, nothing else filled in.
const MAILTO = `mailto:clement@ophis.fi?subject=${encodeURIComponent('Ophis Business support')}&body=${encodeURIComponent('What I was doing:\r\n\r\nWhat I expected:\r\n\r\nWhat happened:\r\n')}`
const PAGE: Record<string, string> = { '/#/organisation': 'Organisation', '/#/compliance': 'Compliance', '/#/security': 'Security and data', '/recover': 'the account recovery page' }
const WHY = {
  none: 'No help text was found for this question.',
  no: 'The help texts did not answer this question.',
  limit: 'You have asked 20 questions in this hour, which is the limit.',
}

export function Support({ onSignedOut }: { onSignedOut: () => void }) {
  const [question, setQuestion] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })

  async function ask(event: FormEvent) {
    event.preventDefault()
    if (!question.trim()) return setView({ kind: 'empty' })
    setView({ kind: 'busy' })
    const result = await api<{ answers?: Entry[]; handover?: boolean; error?: string }>('/api/support/ask', { question })
    if (result.status === 401) return onSignedOut()
    if (result.status === 400) return setView({ kind: result.data.error === 'secret' ? 'secret' : 'empty' })
    // Anything but an answer is the hand-over: no match, the limit, or a failure of ours or the provider's.
    setView(result.status === 200 && result.data.answers?.length ? { kind: 'answer', list: result.data.answers, at: 0 } : { kind: 'handover', why: result.status === 429 ? WHY.limit : WHY.none })
  }
  const entry = view.kind === 'answer' ? view.list[view.at] : undefined

  return (
    <div className="support">
      <header className="ph"><div>
        <span className="cap eyebrow">Support</span>
        <h1 className="h-page">Ask a question, <em>read the help text</em>.</h1>
        <p className="lede">Your question is matched to a fixed set of help texts. If none fits, you write to a person at Ophis.</p>
      </div></header>

      <form className="panel stack" onSubmit={ask}>
        <label className="field">Your question
          <textarea className="input" rows={3} maxLength={MAX} value={question} aria-describedby="sp-count sp-privacy" onChange={(e) => setQuestion(e.target.value)} />
        </label>
        <div className="acts">
          <button className="btn primary md" type="submit" disabled={view.kind === 'busy'}><Icon name="life-buoy" size={16} />Ask</button>
          <span className="fine" id="sp-count">{question.length} of {MAX} characters</span>
        </div>
        <p className="fine" id="sp-privacy"><Icon name="info" size={16} /><span>{PRIVACY} {CARE}</span></p>
      </form>

      <div className="stack" aria-live="polite">
        {view.kind === 'busy' && <p className="fine" role="status">Looking for the matching help text.</p>}
        {view.kind === 'empty' && <div className="note warn" role="status"><Icon name="info" /><span>Type your question in words. Addresses, email addresses, links and long numbers are removed before it is matched.</span></div>}
        {view.kind === 'secret' && <div className="note warn" role="status"><Icon name="info" /><span>This looks like a wallet recovery phrase (seed phrase). It was not passed on and not stored. Never type one into a website, an email or a chat.</span></div>}
        {view.kind === 'thanks' && <div className="note ok" role="status"><Icon name="check" /><span>Good. You can ask another question at any time.</span></div>}
        {entry && view.kind === 'answer' && (
          <section className="panel stack" aria-labelledby="sp-answer">
            <header className="sh"><Tile name="life-buoy" /><div className="tt"><h2 className="h-panel" id="sp-answer">{entry.title}</h2><p>{view.at ? 'Second help text' : 'Help text'} {entry.id}</p></div></header>
            <p className="answer">{entry.text}</p>
            {PAGE[entry.link] && <p><a className="btn ghost sm" href={entry.link}>Open {PAGE[entry.link]}</a></p>}
            <hr className="divider" />
            <div className="acts" role="group" aria-labelledby="sp-ask">
              <span id="sp-ask">Did this answer your question?</span>
              <button className="btn ghost md" type="button" onClick={() => setView({ kind: 'thanks' })}><Icon name="check" size={16} />Yes</button>
              <button className="btn ghost md" type="button" onClick={() => setView(view.at + 1 < view.list.length ? { ...view, at: view.at + 1 } : { kind: 'handover', why: WHY.no })}><Icon name="x" size={16} />No</button>
            </div>
          </section>
        )}
        {view.kind === 'handover' && (
          <section className="panel stack" aria-labelledby="sp-person">
            <header className="sh"><Tile name="user" /><div className="tt"><h2 className="h-panel" id="sp-person">Write to a person</h2><p>{view.why}</p></div></header>
            <p className="answer">The link opens an email to Ophis in your own mail program, with three lines to fill in: what you were doing, what you expected, what happened. Nothing else is filled in for you. Never send a passkey, a private key or a seed phrase.</p>
            <p><a className="btn primary md" href={MAILTO}>Write to Ophis</a></p>
          </section>
        )}
      </div>
    </div>
  )
}
