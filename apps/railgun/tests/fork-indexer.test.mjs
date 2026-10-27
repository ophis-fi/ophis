import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundIndexerResponse, cachedIndexerResponse, fetchPublicIndexer } from './fork-indexer.mjs'

it('reuses public cache data and never overwrites a file inserted during fetching', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'railgun-indexer-'))
  const cache = join(directory, 'cache.json')
  const victim = join(directory, 'unrelated.json')
  const payload = { data: { events: [] } }
  const response = { ok: () => true, json: async () => payload }
  try {
    const fetch = vi.fn().mockResolvedValue(response)
    await expect(cachedIndexerResponse(cache, fetch)).resolves.toEqual(payload)
    await expect(cachedIndexerResponse(cache, fetch)).resolves.toEqual(payload)
    expect(fetch).toHaveBeenCalledTimes(1)
    rmSync(cache)
    writeFileSync(victim, 'do not overwrite')
    await expect(cachedIndexerResponse(cache, async () => {
      symlinkSync(victim, cache)
      return response
    })).resolves.toEqual(payload)
    expect(readFileSync(victim, 'utf8')).toBe('do not overwrite')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('bounds every indexer event and batched response at the pinned fork height', () => {
  const response = { data: { __typename: 'Query', unshields: [{ blockNumber: '100' }, { blockNumber: '101' }] } }
  expect(boundIndexerResponse(response, 100)).toEqual({
    data: { __typename: 'Query', unshields: [{ blockNumber: '100' }] },
  })
  expect(boundIndexerResponse([response], 100)).toEqual([boundIndexerResponse(response, 100)])
  expect(() => boundIndexerResponse({ data: { commitments: [{}] } }, 100)).toThrow(/block number/)
})

it('bounds transient indexer retries and never retries a rejected query', async () => {
  const failed = { ok: () => false, status: () => 502 }
  const good = { ok: () => true, status: () => 200 }
  const fetch = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(good)
  await expect(fetchPublicIndexer(fetch)).resolves.toBe(good)
  expect(fetch).toHaveBeenCalledTimes(2)
  fetch.mockReset().mockResolvedValue(failed)
  await expect(fetchPublicIndexer(fetch)).rejects.toThrow('502')
  expect(fetch).toHaveBeenCalledTimes(3)
  fetch.mockReset().mockResolvedValue({ ok: () => false, status: () => 400 })
  await expect(fetchPublicIndexer(fetch)).rejects.toThrow('400')
  expect(fetch).toHaveBeenCalledTimes(1)
})
