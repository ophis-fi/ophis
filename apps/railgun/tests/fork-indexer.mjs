import { readFileSync, writeFileSync } from 'node:fs'

// Public historical events only. Never include events newer than the Anvil snapshot.
export async function fetchPublicIndexer(fetchResponse) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetchResponse()
    if (response.ok()) return response
    if (attempt === 2 || (response.status() !== 429 && response.status() < 500))
      throw new Error(`Public indexer HTTP ${response.status()}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export async function cachedIndexerResponse(file, fetchResponse) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const response = await fetchPublicIndexer(fetchResponse)
  const payload = await response.json()
  if (payload.errors) throw new Error('Public indexer query failed')
  try {
    writeFileSync(file, JSON.stringify(payload), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return payload
}

export function boundIndexerResponse(response, block) {
  if (Array.isArray(response)) return response.map((item) => boundIndexerResponse(item, block))
  if (!response || typeof response !== 'object' || !response.data) throw new Error('Invalid public indexer response')
  const data = Object.fromEntries(
    Object.entries(response.data).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.filter((event) => {
            if (!event || event.blockNumber == null) throw new Error('Public event is missing its block number')
            return BigInt(event.blockNumber) <= BigInt(block)
          })
        : value,
    ]),
  )
  return { ...response, data }
}
