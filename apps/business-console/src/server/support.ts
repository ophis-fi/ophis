// Support (milestone 6): "select, do not generate". An outside model (Jev, by TypeSafe AI) picks entries of the fixed
// answer base in answers.ts; the member only ever reads those texts. What leaves this server: the cleaned question and
// the ids, titles and one-line descriptions of the answer base, in one request. Never an organisation, a member, a
// wallet, an id or a session value. The question is not stored and not logged, and there is no audit row: the one
// write is the hourly counter of the seat.
import { english } from 'viem/accounts'
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

// One form per character before anything is judged: full-width letters and digits become plain ones (NFKC), and
// characters that take no room (zero-width space and joiners, soft hyphen, direction marks) go, so that neither splits a value.
const plain = (raw: string) => raw.normalize('NFKC').replace(/\p{Cf}/gu, '')
const SEED = new Map(english.map((word, i) => [word, i]))
// BIP-39: each word is an 11-bit number; the last bits of a phrase (one per 3 words) are the first bits of the SHA-256 of the rest.
async function checksum(words: string[]) {
  const bits = words.map((word) => SEED.get(word)!.toString(2).padStart(11, '0')).join('')
  const split = bits.length - words.length / 3
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bits.slice(0, split).match(/.{8}/g)!, (byte) => parseInt(byte, 2))))
  return bits.slice(split) === hash[0].toString(2).padStart(8, '0').slice(0, words.length / 3)
}
/**
 * A wallet recovery phrase: words of the BIP-39 English list in a row, whatever stands between them (numbers, commas,
 * lines): 12 or 15 of them with a valid checksum, or 16 or more whatever the checksum (a phrase of 24, also mistyped
 * or cut). Such a question is refused whole, so that no part of the phrase leaves and its member is told. A plain
 * question of 12 to 15 list words ("can you cancel this account change ...") passes unless its last word happens to
 * be a checksum: 1 in 16 for a window of 12.
 * ponytail: the English list only (it ships with viem); a phrase in another language, or 12 words of which one is
 * mistyped or missing, is not seen.
 */
export async function secret(raw: string): Promise<boolean> {
  const words = plain(raw).toLowerCase().split(/[^a-z]+/)
  for (let i = 0, start = 0; i <= words.length; i++) {
    if (SEED.has(words[i])) continue
    const run = words.slice(start, i)
    start = i + 1
    if (run.length >= 16) return true
    for (const size of [12, 15]) for (let at = 0; at + size <= run.length; at++) if (await checksum(run.slice(at, at + size))) return true
  }
  return false
}

/**
 * What may leave: the question without a word that holds an email address, a URL or a domain name in any script (a
 * company's, or a wallet name such as an ENS name), without a word of 24 or more characters that holds a digit (an
 * address or key of another chain, a token), without 0x values and long hex strings (addresses, transactions, keys),
 * also when typed in groups, without runs of 6 or more digits (phone, account numbers), whatever parts the groups or
 * the digits short of a letter, with single spaces, 500 characters at most. Whole words go, so nothing of them is left behind.
 */
export function clean(raw: string): string {
  return plain(raw).split(/\s+/).filter((word) => !/@|:\/\/|[\p{L}\p{Nd}]\.\p{L}{2,}|^(?=.*\p{Nd}).{24,}$/u.test(word)).join(' ')
    // Hex in groups: 16 or more hex characters in all with a digit among them (the 0 of 0x is one). Words such as "a bad decade" hold none.
    .replace(/(?<![0-9a-z])(?:0x)?[0-9a-f]+(?:[^0-9a-z]{1,3}[0-9a-f]+)+(?![0-9a-z])/gi, (run) => (/\d/.test(run) && run.replace(/[^0-9a-f]/gi, '').length >= 16 ? ' ' : run))
    .replace(/0x[0-9a-f]+|[0-9a-f]{16,}/gi, ' ')
    .replace(/\p{Nd}(?:[^\p{L}\p{Nd}]{0,3}\p{Nd}){5,}/gu, ' ')
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
    body: requestBody(question), signal: AbortSignal.timeout(LIMITS.timeoutMs), redirect: 'manual', // a redirect is not followed: its status is a failure below (Workers has no 'error' mode)
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
  const raw = typeof c.body.question === 'string' ? c.body.question : ''
  if (await secret(raw)) return Response.json({ error: 'secret' }, { status: 400 })
  const question = clean(raw)
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
