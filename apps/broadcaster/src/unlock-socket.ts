import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { MAX_UNLOCK_BYTES } from './custody'
import { privateDirectory } from './storage'

export async function receiveUnlock<T>(path: string, accept: (data: Buffer) => T, signal: AbortSignal): Promise<{ value: Promise<T>; close: () => Promise<void> }> {
  privateDirectory(dirname(path))
  const sockets = new Set<Socket>()
  let accepted = false
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const value = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // Cancellation may arrive before the caller starts awaiting the unlock.
  void value.catch(() => {})
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (accepted || sockets.size) { socket.destroy(); return }
    sockets.add(socket)
    let parts: Buffer[] = [], size = 0
    const clear = () => { for (const part of parts) part.fill(0); parts = [] }
    socket.setTimeout(5000, () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_UNLOCK_BYTES) { chunk.fill(0); clear(); socket.destroy(); return }
      parts.push(chunk)
    })
    socket.on('error', () => {})
    socket.once('close', () => { clear(); sockets.delete(socket) })
    socket.once('end', () => {
      const data = Buffer.concat(parts)
      clear()
      try {
        if (accepted || signal.aborted || !size || size > MAX_UNLOCK_BYTES) throw new Error()
        const result = accept(data)
        accepted = true
        socket.end('unlocked\n', () => resolve(result))
      } catch { socket.end('rejected\n') } finally { data.fill(0) }
    })
  })
  server.maxConnections = 1
  const abort = () => { reject(new Error('Operator unlock stopped.')); for (const socket of sockets) socket.destroy(); server.close() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('Operator unlock stopped.')
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(path, yes) })
    chmodSync(path, 0o600)
  } catch (error) { signal.removeEventListener('abort', abort); server.close(); throw error }
  return { value, close: async () => {
    signal.removeEventListener('abort', abort)
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((yes) => server.close(() => yes()))
    try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } }
}

function unlockEndpoint(path: string) {
  const directory = lstatSync(dirname(path))
  if ((directory.mode & 0o777) !== 0o700) throw new Error('The unlock directory must have private permissions (0700).')
  privateDirectory(dirname(path))
  const endpoint = lstatSync(path)
  if (!endpoint.isSocket() || endpoint.uid !== process.getuid?.() || (endpoint.mode & 0o077))
    throw new Error('The unlock endpoint must be an owned private socket.')
  return { directory, endpoint }
}

export async function sendUnlock(path: string, data: Buffer): Promise<void> {
  if (!data.length || data.length > MAX_UNLOCK_BYTES) throw new Error('Invalid operator unlock payload.')
  const expected = unlockEndpoint(path)
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path)
    let response = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Operator unlock timed out.')))
    socket.once('connect', () => {
      try {
        // shortcut: path checks cannot authenticate same-UID peers; add OS peer credentials if that threat enters scope.
        const current = unlockEndpoint(path)
        if (current.directory.dev !== expected.directory.dev || current.directory.ino !== expected.directory.ino ||
          current.endpoint.dev !== expected.endpoint.dev || current.endpoint.ino !== expected.endpoint.ino)
          throw new Error()
        socket.end(data)
      } catch { socket.destroy(new Error('The operator unlock endpoint changed or became unsafe.')) }
    })
    socket.on('data', (chunk) => { response += chunk.toString(); if (response.length > 64) socket.destroy(new Error('Invalid unlock response.')) })
    socket.once('error', reject)
    socket.once('end', () => { if (response === 'unlocked\n') resolve(); else reject(new Error('Operator unlock rejected.')) })
  })
}

export async function stdinUnlock(): Promise<Buffer> {
  const parts: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of process.stdin) {
      const data = Buffer.from(chunk)
      size += data.length
      if (size > MAX_UNLOCK_BYTES) { data.fill(0); throw new Error('Operator unlock input is too large.') }
      parts.push(data)
    }
    if (!size) throw new Error('Empty operator unlock input.')
    return Buffer.concat(parts)
  } finally { for (const part of parts) part.fill(0) }
}
