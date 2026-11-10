import { CHAIN_ID, MAX_MESSAGE_BYTES, PUBSUB_TOPIC, TOPICS } from './config'
import { creditTopics, encryptedCreditTopic } from '../../railgun/credit-protocol'
import { object } from './wire'

export async function boundedJSON(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('Upstream request failed.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maxBytes) throw new Error('Upstream response exceeds the size limit.')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined) }
}

export class WakuRelay {
  saturated = false
  private readonly topicPath: string
  constructor(private readonly endpoint: string, private readonly pubsubTopic = PUBSUB_TOPIC) {
    this.topicPath = `relay/v1/messages/${encodeURIComponent(pubsubTopic)}`
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.endpoint), {
      method, headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000),
    })
    if (method === 'POST' && response.ok) { await response.body?.cancel(); return }
    return boundedJSON(response, 16 * 1024 * 1024)
  }
  async subscribe(): Promise<void> { await this.request('relay/v1/subscriptions', 'POST', [this.pubsubTopic]) }
  async publish(contentTopic: string, payload: Uint8Array): Promise<void> {
    if (payload.length > MAX_MESSAGE_BYTES) throw new Error('Waku message exceeds its size limit.')
    await this.request(this.topicPath, 'POST', { payload: Buffer.from(payload).toString('base64'),
      contentTopic, version: 0, timestamp: Date.now() * 1_000_000, ephemeral: false })
  }
  async messages(): Promise<{ payload: Uint8Array; responseTopic: string }[]> {
    const value = await this.request(this.topicPath)
    if (!Array.isArray(value)) throw new Error('Waku REST returned an invalid message list.')
    // shortcut: relay GET clears its cache before delivery, use an acknowledged inbox if client retries become insufficient.
    this.saturated ||= value.length >= 16
    return value.flatMap((entry) => {
      const prepaid = creditTopics(CHAIN_ID)
      if (!object(entry) || (entry.contentTopic !== TOPICS.transact && entry.contentTopic !== encryptedCreditTopic(prepaid.request)) || typeof entry.payload !== 'string' ||
        entry.payload.length > Math.ceil(MAX_MESSAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.payload)) return []
      const bytes = Buffer.from(entry.payload, 'base64')
      return bytes.length <= MAX_MESSAGE_BYTES ? [{ payload: bytes, responseTopic: entry.contentTopic === TOPICS.transact
        ? TOPICS.response : encryptedCreditTopic(prepaid.response) }] : []
    })
  }
}
