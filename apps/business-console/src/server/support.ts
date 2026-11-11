// Support (milestone 6): "select, do not generate". An outside model (Jev, by TypeSafe AI) picks entries of the fixed
// answer base in answers.ts; the member only ever reads those texts. What leaves this server: the cleaned question and
// the ids, titles and one-line descriptions of the answer base, in one request. Never an organisation, a member, a
// wallet, an id or a session value. The question is not stored and not logged, and there is no audit row: the one
// write is the hourly counter of the seat.
import { ANSWERS, type Answer } from './answers.ts'
import { readCapped } from './chain.ts'
import { countHour } from './data.ts'
import { SUPPORT_HOSTS } from './passkeys.ts'

export const MODEL = 'jev-1.14.0' // pinned: an alias can move to another model and change the answers
export const LIMITS = { timeoutMs: 3000, perHour: 20, chars: 500, answerBytes: 16 * 1024 }
// support-jev.md section 4: 0.7 is "yes", for the question "is it answered" and for the chosen entry.
const SURE = 0.7
const NONE = 'none'
const IDS = [...ANSWERS.map((a) => a.id), NONE]

/**
 * What may leave: the question without a word that holds an email address or a URL, without 0x values and long hex
 * strings (addresses, transactions, keys), without runs of 6 or more digits (also when spaced: phone, account
 * numbers), with single spaces, 500 characters at most. Whole words go, so nothing of them is left behind.
 */
export function clean(raw: string): string {
  return raw.split(/\s+/).filter((word) => !/@|:\/\/|^www\./i.test(word)).join(' ')
    .replace(/0x[0-9a-f]+|[0-9a-f]{16,}/gi, ' ')
    .replace(/\d(?:[ .-]?\d){5,}/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, LIMITS.chars).trim()
}

// Two questions over the same state, in one request. A Choice always picks something, so it gets a "none" option and
// a Noul next to it. Ids are ours; the model sees titles and one line each, never the texts.
const ENTRIES = Object.fromEntries(ANSWERS.map((a) => [a.id, { title: a.title, description: a.about }]))
const QUESTIONS = {
  entry: {
    type: 'choice', instructions: 'Which entry in `entries` is about what `question` asks?',
    criteria: { ...Object.fromEntries(ANSWERS.map((a) => [a.id, a.title])), [NONE]: 'No entry is about what the question asks, or it asks for advice, an opinion or data that a help text cannot contain.' },
  },
  answered: {
    type: 'noul', instructions: 'Would the help text of one entry in `entries` answer `question`?',
    criteria: {
      true: 'One entry covers what the user asks: how to do it in the console, how it works, or whether it is available.',
      false: 'No entry covers it, or it asks for an opinion, a recommendation, a decision, a promise, or data about a specific account, order or organisation.',
    },
  },
}
/** The body of the one request: the cleaned question and the answer base, nothing else. */
export const requestBody = (question: string) => JSON.stringify({ model: MODEL, state: { question, entries: ENTRIES }, questions: QUESTIONS })

const named = (name: string) => Object.assign(new Error(name), { name })
const probability = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1

/** The rules, in code: sure that it is answered, and not "none". Below 0.7 for the best entry the second best comes too. */
export function pick(p: Record<string, number>, answered: number): Answer[] {
  const ranked = [...IDS].sort((a, b) => p[b] - p[a])
  if (answered < SURE || ranked[0] === NONE) return []
  const ids = p[ranked[0]] >= SURE || ranked[1] === NONE ? [ranked[0]] : ranked.slice(0, 2)
  return ids.map((id) => ANSWERS.find((a) => a.id === id)!)
}

/** One request to the provider. Returns the entries to show, none for the hand-over. Throws by name, never with a value. */
export async function select(question: string, key: string, host: string): Promise<Answer[]> {
  const response = await fetch(`https://${host}/v1/systemone`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: requestBody(question), signal: AbortSignal.timeout(LIMITS.timeoutMs),
  })
  if (!response.ok) throw named('provider_status')
  const text = await readCapped(response.body, LIMITS.answerBytes)
  let answers: { entry?: { probabilities?: Record<string, unknown> }; answered?: { noul?: unknown } } | undefined
  try {
    answers = JSON.parse(text ?? '')?.answers
  } catch {
    throw named('provider_shape')
  }
  const p = answers?.entry?.probabilities, yes = answers?.answered?.noul
  if (!p || typeof p !== 'object' || !IDS.every((id) => probability(p[id])) || !probability(yes)) throw named('provider_shape')
  return pick(p as Record<string, number>, yes)
}

// The route's context, as much as this handler reads. TYPESAFE_API_KEY is a Worker secret (.dev.vars locally).
interface Asked {
  env: { DB: D1Database; ENVIRONMENT: string; TYPESAFE_API_KEY?: string }
  actor: { seatId: string }; body: Record<string, unknown>; now: number
}
/** POST /api/support/ask. Answers { answers: [one or two entries] } or { handover: true }; a failure is a hand-over. */
export async function ask(c: Asked): Promise<Response> {
  const question = typeof c.body.question === 'string' ? clean(c.body.question) : ''
  if (!question) return Response.json({ error: 'invalid' }, { status: 400 })
  if (!(await countHour(c.env.DB, `seat:${c.actor.seatId}`, c.now, LIMITS.perHour))) return Response.json({ error: 'too_many' }, { status: 429 })
  try {
    if (!c.env.TYPESAFE_API_KEY) throw named('no_key')
    const found = await select(question, c.env.TYPESAFE_API_KEY, SUPPORT_HOSTS[c.env.ENVIRONMENT])
    if (found.length) return Response.json({ answers: found.map(({ id, title, text, link }) => ({ id, title, text, link })) })
  } catch (error) {
    // By name only: never the question, the key or what the provider said.
    console.error('support failure', error instanceof Error ? error.name : 'unknown')
  }
  return Response.json({ handover: true })
}
