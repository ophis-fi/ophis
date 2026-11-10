import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { encryptDataWithSharedKey, tryDecryptJSONDataWithSharedKey } from '@railgun-community/wallet'
import { WakuRelay, boundedJSON } from '../src/waku'
import { encryptResponse, openRequest } from '../src/wire'
import { TOPICS } from '../src/config'

it.runIf(!!process.env.OPHIS_TEST_WAKU)('carries SDK encrypted requests and responses through a real isolated nwaku REST relay', async () => {
  const url = new URL(process.env.OPHIS_TEST_WAKU!)
  expect(['127.0.0.1', '[::1]']).toContain(url.hostname)
  const relay = new WakuRelay(url.href, '/waku/2/rs/0/0')
  await relay.subscribe(); await relay.messages()
  const privateKey = randomBytes(32), publicKey = await ed.getPublicKey(privateKey)
  const viewingKey = Buffer.from(publicKey).toString('hex')
  const data = await encryptDataWithSharedKey({ broadcasterViewingKey: viewingKey }, publicKey)
  await relay.publish(TOPICS.transact, Buffer.from(JSON.stringify({ method: 'transact', id: 1,
    params: { pubkey: data.randomPubKey, encryptedData: data.encryptedData } })))
  const messages = await relay.messages()
  const request = await openRequest(messages[0].payload, privateKey, viewingKey)
  expect(request).toBeDefined()
  const encrypted = encryptResponse({ txHash: 'local-test-only' }, request!)
  await relay.publish(TOPICS.response, Buffer.from(JSON.stringify({ result: JSON.parse(encrypted) })))
  const response = await boundedJSON(await fetch(new URL(`relay/v1/messages/${encodeURIComponent('/waku/2/rs/0/0')}`, url)), 1024 * 1024) as { payload: string }[]
  const body = JSON.parse(Buffer.from(response[0].payload, 'base64').toString())
  expect(tryDecryptJSONDataWithSharedKey(body.result, data.sharedKey)).toEqual({ txHash: 'local-test-only' })
}, 15_000)
