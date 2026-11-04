import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { forkProtectedSender } from './protected-sender.fixture'
import { PROTECTED_WRITE_RPC } from '../../railgun/operator/protected-provider'

it('blocks late private writes after fixture shutdown while ordinary reads retain their transport', async () => {
  const original = globalThis.fetch
  const network = vi.fn(async () => new Response('read-only', { status: 200 }))
  globalThis.fetch = network
  const root = mkdtempSync(join(tmpdir(), 'ophis-closed-protected-test-'))
  let fixture: Awaited<ReturnType<typeof forkProtectedSender>> | undefined
  try {
    fixture = await forkProtectedSender('http://127.0.0.1:1', Wallet.createRandom().address, Wallet.createRandom().address, root)
    await fixture.close()
    await expect(globalThis.fetch(PROTECTED_WRITE_RPC, { method: 'POST', body: 'late private payload' }))
      .rejects.toThrow('closed')
    expect(network).not.toHaveBeenCalled()
    expect((await globalThis.fetch('http://127.0.0.1:1/read')).status).toBe(200)
    expect(network).toHaveBeenCalledOnce()
  } finally {
    globalThis.fetch = original
    rmSync(root, { recursive: true, force: true })
  }
})
