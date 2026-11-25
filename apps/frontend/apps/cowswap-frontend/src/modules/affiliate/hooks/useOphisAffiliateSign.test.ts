import { renderHook } from '@testing-library/react'

import { useOphisAffiliateSign } from './useOphisAffiliateSign'

import { bindRefCode, createRefCode, getPartnerDashboard, submitRewardClaim } from '../lib/ophisAffiliateApi'

const mockSignMessage = jest.fn().mockResolvedValue('0xsigned')
const mockProvider = {
  getNetwork: jest.fn().mockResolvedValue({ chainId: 5042 }),
  getSigner: () => ({ signMessage: mockSignMessage }),
}
let mockSolana: unknown = null
jest.mock('jotai', () => ({ useAtomValue: () => mockSolana }))
jest.mock('entities/solana', () => ({
  OPHIS_SOLANA_CONFIG: { chain: 'solana:mainnet' },
  solanaConnectionAtom: 'connection',
}))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => mockProvider }))

const wallet = '0xAbC0000000000000000000000000000000000001'
const issued = 1_800_000_000
const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  jest.restoreAllMocks()
  jest.clearAllMocks()
})

it('binds the message and every signed API body to the wallet provider chain', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(issued * 1000)
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  global.fetch = fetchMock
  const { result } = renderHook(() => useOphisAffiliateSign(wallet))
  const signed = await result.current('Partner Dashboard access')
  expect(mockSignMessage).toHaveBeenCalledWith(
    `Ophis Partner Dashboard access\nAddress: ${wallet.toLowerCase()}\nIssued: ${issued}\nChain ID: 5042`,
  )
  expect(signed).toEqual({ wallet, issued, signature: '0xsigned', chainId: 5042 })

  await getPartnerDashboard(signed)
  await createRefCode(signed)
  await bindRefCode({
    referredWallet: signed.wallet,
    code: 'partner',
    issued,
    signature: signed.signature,
    chainId: signed.chainId,
  })
  await submitRewardClaim({ ...signed, rewardId: 'perk', email: 'person@example.com' })
  expect(fetchMock).toHaveBeenCalledTimes(4)
  for (const [, init] of fetchMock.mock.calls) {
    expect(JSON.parse(init.body)).toMatchObject({ chainId: 5042, issued, signature: '0xsigned' })
  }
})

it('signs the exact mainnet referral message from the selected Solana account', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(issued * 1000)
  const address = '63oxKoqF8skx14fGcbNfhrKtanKPHg6X6NyUw4qPirnA'
  const account = { address, features: ['solana:signMessage'], chains: ['solana:mainnet'] }
  const signMessage = jest.fn(async ({ message }: { message: Uint8Array }) => [
    { signature: new Uint8Array(64).fill(1), signedMessage: message },
  ])
  mockSolana = { account, wallet: { accounts: [account], features: { 'solana:signMessage': { signMessage } } } }
  const { result } = renderHook(() => useOphisAffiliateSign(address))
  const body = await result.current('bind referral code partner')
  expect(Buffer.from(signMessage.mock.calls[0][0].message).toString()).toEqual(
    `Ophis bind referral code partner\nAddress: ${address}\nIssued: ${issued}\nChain: solana:mainnet`,
  )
  expect(body).toEqual({ wallet: address, signature: '0x' + '01'.repeat(64), issued })
  expect(mockSignMessage).not.toHaveBeenCalled()
  account.features = []
  await expect(result.current('Partner Dashboard access')).rejects.toThrow('supports message signing')
  mockSolana = null
})
