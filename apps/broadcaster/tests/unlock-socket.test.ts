import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendUnlock } from '../src/unlock-socket'

const io = vi.hoisted(() => ({ stat: vi.fn(), connect: vi.fn() }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  io.stat.mockImplementation(actual.lstatSync)
  return { ...actual, lstatSync: io.stat }
})
vi.mock('node:net', async (original) => {
  const actual = await original<typeof import('node:net')>()
  io.connect.mockImplementation(actual.createConnection)
  return { ...actual, createConnection: io.connect }
})

let root: string
const close: (() => Promise<void>)[] = []
beforeEach(async () => {
  io.stat.mockReset().mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).lstatSync)
  io.connect.mockClear()
  root = mkdtempSync(join(tmpdir(), 'unlock-'))
})
afterEach(async () => {
  for (const stop of close.splice(0)) await stop()
  rmSync(root, { recursive: true, force: true })
})

async function endpoint() {
  const parent = join(root, 'p'), path = join(parent, 'u')
  mkdirSync(parent, { mode: 0o700 })
  const received = { bytes: 0, connections: 0 }, sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    received.connections++; sockets.add(socket)
    socket.on('data', (chunk) => { received.bytes += chunk.length })
    socket.on('error', () => {})
    socket.on('end', () => socket.end('unlocked\n'))
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  chmodSync(path, 0o600)
  close.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { parent, path, received }
}

it('sends an unlock payload only to an owned private directory and socket', async () => {
  const f = await endpoint(), payload = Buffer.from('dummy unlock payload')
  await sendUnlock(f.path, payload)
  expect(f.received).toEqual({ bytes: payload.length, connections: 1 })
  expect(io.connect).toHaveBeenCalledOnce()
})

it.each(['directory owner', 'socket owner', 'directory symlink', 'socket symlink', 'regular file', 'directory endpoint',
  'public directory', 'public socket'])('rejects an unsafe %s before connecting or sending plaintext', async (condition) => {
  const f = await endpoint()
  let path = f.path
  if (condition.endsWith('owner')) {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const target = condition === 'directory owner' ? f.parent : f.path
    io.stat.mockImplementation((entry: string) => {
      const stat = actual.lstatSync(entry)
      return entry === target ? new Proxy(stat, { get: (value, key) => key === 'uid'
        ? (process.getuid?.() ?? 0) + 1 : Reflect.get(value, key) }) : stat
    })
  }
  if (condition === 'directory symlink') {
    const alias = join(root, 'link'); symlinkSync(f.parent, alias); path = join(alias, 'u')
  }
  if (condition === 'socket symlink') { path = join(f.parent, 'link'); symlinkSync(f.path, path) }
  if (condition === 'regular file') { path = join(f.parent, 'file'); writeFileSync(path, 'not a socket', { mode: 0o600 }) }
  if (condition === 'directory endpoint') { path = join(f.parent, 'dir'); mkdirSync(path, { mode: 0o700 }) }
  if (condition === 'public directory') chmodSync(f.parent, 0o755)
  if (condition === 'public socket') chmodSync(f.path, 0o660)
  await expect(sendUnlock(path, Buffer.from('dummy unlock payload'))).rejects.toThrow()
  expect(io.connect).not.toHaveBeenCalled()
  expect(f.received).toEqual({ bytes: 0, connections: 0 })
})

it('does not create a missing unlock directory before rejecting it', async () => {
  const parent = join(root, 'missing')
  await expect(sendUnlock(join(parent, 'u'), Buffer.from('dummy unlock payload'))).rejects.toThrow()
  expect(existsSync(parent)).toBe(false)
  expect(io.connect).not.toHaveBeenCalled()
})

it.each(['directory', 'socket'])('rechecks the %s identity before writing on a connected socket', async (condition) => {
  const f = await endpoint()
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const target = condition === 'directory' ? f.parent : f.path
  let reads = 0
  io.stat.mockImplementation((entry: string) => {
    const stat = actual.lstatSync(entry)
    if (entry !== target || ++reads <= (condition === 'directory' ? 2 : 1)) return stat
    return new Proxy(stat, { get: (value, key) => key === 'ino' ? value.ino + 1 : Reflect.get(value, key) })
  })
  await expect(sendUnlock(f.path, Buffer.from('dummy unlock payload'))).rejects.toThrow('changed or became unsafe')
  expect(io.connect).toHaveBeenCalledOnce()
  expect(f.received.bytes).toBe(0)
})
