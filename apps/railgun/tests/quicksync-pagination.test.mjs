import { expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const wallet = createRequire(require.resolve('@railgun-community/wallet'))
const directory = join(dirname(wallet.resolve('./index.js')), 'services/railgun/quick-sync/V2')
const entry = join(directory, 'quick-sync-events-graph-v2.js')
const graphql = wallet(join(directory, 'graphql/index.js'))
const runtime = createRequire(wallet.resolve('@graphql-mesh/runtime'))('./get-mesh.js')

it.each([false, true])('fetches independent V2 histories concurrently and rejects partial history on failure=%s', async (fail) => {
  const previous = { options: graphql.getMeshOptions, mesh: runtime.getMesh, cached: require.cache[entry] }
  const started = [], gates = new Map()
  for (const name of ['Nullifiers', 'Unshields', 'Commitments']) {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    gates.set(name, { promise, resolve, reject })
  }
  let pending
  try {
    graphql.getMeshOptions = async () => ({ sources: [{ name: 'ethereum' }] })
    runtime.getMesh = async () => ({ pubsub: { subscribe: () => 1, unsubscribe() {} },
      sdkRequesterFactory: () => async (document) => {
        const name = document.definitions.find((item) => item.kind === 'OperationDefinition').name.value
        started.push(name)
        return gates.get(name).promise
      } })
    delete require.cache[entry]
    pending = wallet(entry).quickSyncEventsGraphV2({ type: 0, id: 1 }, 14737691)
    await expect.poll(() => started).toEqual(['Nullifiers', 'Unshields', 'Commitments'])
    if (fail) {
      gates.get('Unshields').reject(new Error('History unavailable'))
      await expect(pending).rejects.toThrow('History unavailable')
    } else {
      for (const [name, gate] of gates) gate.resolve({ [name.toLowerCase()]: [] })
      await expect(pending).resolves.toEqual({ commitmentEvents: [], nullifierEvents: [], unshieldEvents: [] })
    }
  } finally {
    for (const [name, gate] of gates) gate.resolve({ [name.toLowerCase()]: [] })
    await pending?.catch(() => {})
    graphql.getMeshOptions = previous.options
    runtime.getMesh = previous.mesh
    if (previous.cached) require.cache[entry] = previous.cached
    else delete require.cache[entry]
  }
})
