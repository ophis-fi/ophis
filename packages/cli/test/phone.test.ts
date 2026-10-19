import { beforeEach, expect, mock, spyOn, test } from 'bun:test'

// The wallet app, as WalletConnect reaches it: a session for Base and OP Mainnet that signs whatever it is asked.
const ME = '0x1111111111111111111111111111111111111111' as const
const SIGNATURE = `0x${'ab'.repeat(32)}` as const
const asked: { chainId: string }[] = []
let accounts: string[]
let answer: () => Promise<string>
beforeEach(() => {
  accounts = [`eip155:8453:${ME}`, `eip155:10:${ME}`]
  answer = async () => SIGNATURE
  asked.length = 0
})
mock.module('@walletconnect/sign-client', () => ({
  default: {
    init: async () => ({
      session: { getAll: () => [{ topic: 't', expiry: 2 ** 40, namespaces: { eip155: { accounts } } }] },
      request: async (r: { chainId: string }) => (asked.push(r), answer()),
    }),
  },
}))
const { accountsOf, pairingFailed, phoneSigner, showQrImage, terminalQr } = await import('../src/phone.ts')

test('the terminal QR code paints both squares of every character, so no stripe shows between lines', async () => {
  const QRCode = (await import('qrcode')).default
  const text = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}&expiryTimestamp=1792322178`
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'L' })
  // Read the squares back: background = top square, foreground = bottom square (16 = black, 231 = white).
  const read = terminalQr(text)
    .trimEnd()
    .split('\n')
    .flatMap((line) => {
      const cells = [...line.matchAll(/\x1b\[48;5;(16|231);38;5;(16|231)m▄/g)]
      return [cells.map((m) => m[1] === '16'), cells.map((m) => m[2] === '16')]
    })
  const size = modules.size + 8 // the code and a white border of four squares on each side
  const expected = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => r >= 4 && c >= 4 && r < size - 4 && c < size - 4 && !!modules.get(r - 4, c - 4)),
  )
  expect(read.slice(0, size)).toEqual(expected)
  expect(read.slice(size).flat().includes(true)).toBe(false) // an odd row count ends on white
})

test('the pairing QR code opens as an image, kept private and deleted once the pairing ends', async () => {
  const { existsSync, statSync } = await import('node:fs')
  const opened: string[] = []
  const image = await showQrImage('wc:test@2?relay-protocol=irn&symKey=00', async (file) => {
    expect(statSync(file).mode & 0o777).toBe(0o600) // private before any viewer reads it
    return opened.push(file) > 0
  })
  expect(image.opened).toBe(true)
  expect(opened).toHaveLength(1)
  expect(existsSync(opened[0]!)).toBe(true)
  image.remove()
  expect(existsSync(opened[0]!)).toBe(false)
  // No image viewer (a bare Linux server): no claim that it opened, and no key left on disk.
  const none = await showQrImage('wc:test@2?relay-protocol=irn&symKey=00', async () => false)
  expect(none.opened).toBe(false)
  expect(existsSync(opened[0]!)).toBe(false)
})

test('WalletConnect failures read as plain sentences, whatever their code', () => {
  expect(pairingFailed({ code: 8000, message: 'Proposal expired' }).message).toBe('No wallet connected within 5 minutes. Run ophis connect again.')
  expect(pairingFailed({ code: 5000, message: 'User rejected.' }).message).toBe('Your wallet declined the connection.')
  expect(pairingFailed({ code: 1, message: 'relay \u001b[2Jdown' }).message).toBe('The wallet did not connect: relay [2Jdown')
  expect(pairingFailed('socket hang up').message).toBe('The wallet did not connect: socket hang up')
})

test('a chain where the wallet gave another account is left out: nothing is signed there as the wrong owner', () => {
  const other = '0x2222222222222222222222222222222222222222'
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:8453:${ME}`, `eip155:42161:${other}`, 'eip155:10:junk'] } } }
  expect(accountsOf(session as never)).toEqual({ address: ME, chains: [1, 8453], otherChains: [42161] })
  session.namespaces.eip155.accounts.push(`eip155:42161:${ME}`)
  expect(accountsOf(session as never).otherChains).toEqual([]) // this owner was also approved there
})

test('a chain approved under another address explains the account mismatch and never reaches the wallet', async () => {
  accounts.push('eip155:42161:0x2222222222222222222222222222222222222222')
  await expect(phoneSigner(42161)).rejects.toThrow('approved this chain under another address. Run ophis connect again and pick the same account on every network.')
  await expect(phoneSigner(1)).rejects.toThrow('did not connect this chain')
  expect(asked).toEqual([])
})

test('expired and unanswered wallet requests explain how to reconnect and warn about a possibly sent transaction', async () => {
  const setTimer = globalThis.setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => setTimer(fn, ms === 300_000 ? 1 : ms)) as typeof setTimeout)
  try {
    const wallet = await phoneSigner(8453)
    for (const reply of [async () => { throw new Error('Request expired') }, () => new Promise<string>(() => {})]) {
      answer = reply
      const error = await wallet.sendTransaction(8453, { to: ME }).catch((err: Error) => err.message)
      expect(error).toContain('Your wallet did not answer')
      expect(error).toContain('Open your wallet app and keep it open')
      expect(error).toContain('Ledger Wallet, stay on its WalletConnect screen')
      expect(error).toContain('run ophis connect again')
      expect(error).toContain('Rabby')
      expect(error).toContain("Check your wallet's activity first: the transaction may already have been sent")
    }
    answer = async () => { throw new Error('Request expired') }
    const typed = { domain: { chainId: 8453 } } as never
    const error = await wallet.signTypedData(8453, typed).catch((err: Error) => err.message)
    expect(error).toContain('keep it open')
    expect(error).not.toContain('may already have been sent')
    answer = async () => { throw new Error('User rejected') }
    await expect(wallet.sendTransaction(8453, { to: ME })).rejects.toThrow('You declined the request')
  } finally {
    timer.mockRestore()
  }
})

test('the wallet is only asked on the chain the signer was opened for', async () => {
  const wallet = await phoneSigner(8453)
  const typed = (chainId: number) => ({ domain: { name: 'X', version: '1', chainId, verifyingContract: ME }, types: {}, primaryType: 'X', message: {} }) as never
  await expect(wallet.sendTransaction(10, { to: ME, data: '0x' } as never)).rejects.toThrow('Nothing was sent')
  await expect(wallet.signTypedData(10, typed(10))).rejects.toThrow('Nothing was sent')
  await expect(wallet.signTypedData(8453, typed(10))).rejects.toThrow('Nothing was sent') // data signed for another chain
  expect(asked).toEqual([])
  expect(await wallet.signTypedData(8453, typed(8453))).toBe(SIGNATURE)
  expect(asked.map((r) => r.chainId)).toEqual(['eip155:8453'])
})
