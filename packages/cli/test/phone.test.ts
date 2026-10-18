import { expect, mock, test } from 'bun:test'

// The wallet app, as WalletConnect reaches it: a session for Base and OP Mainnet that signs whatever it is asked.
const ME = '0x1111111111111111111111111111111111111111' as const
const SIGNATURE = `0x${'ab'.repeat(32)}` as const
const asked: { chainId: string }[] = []
mock.module('@walletconnect/sign-client', () => ({
  default: {
    init: async () => ({
      session: { getAll: () => [{ topic: 't', expiry: 2 ** 40, namespaces: { eip155: { accounts: [`eip155:8453:${ME}`, `eip155:10:${ME}`] } } }] },
      request: async (r: { chainId: string }) => (asked.push(r), SIGNATURE),
    }),
  },
}))
const { accountsOf, pairingFailed, phoneSigner } = await import('../src/phone.ts')

test('WalletConnect failures read as plain sentences, whatever their code', () => {
  expect(pairingFailed({ code: 8000, message: 'Proposal expired' }).message).toBe('No wallet connected within 5 minutes. Run ophis connect again.')
  expect(pairingFailed({ code: 5000, message: 'User rejected.' }).message).toBe('Your wallet declined the connection.')
  expect(pairingFailed({ code: 1, message: 'relay \u001b[2Jdown' }).message).toBe('The wallet did not connect: relay [2Jdown')
  expect(pairingFailed('socket hang up').message).toBe('The wallet did not connect: socket hang up')
})

test('a chain where the wallet gave another account is left out: nothing is signed there as the wrong owner', () => {
  const other = '0x2222222222222222222222222222222222222222'
  const session = { namespaces: { eip155: { accounts: [`eip155:1:${ME}`, `eip155:8453:${ME}`, `eip155:42161:${other}`, 'eip155:10:junk'] } } }
  expect(accountsOf(session as never)).toEqual({ address: ME, chains: [1, 8453] })
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
