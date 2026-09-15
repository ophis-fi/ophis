import { AdditionalTargetChainId, SupportedChainId } from '@cowprotocol/cow-sdk'
import { verifyOphisNameResolution } from '@cowprotocol/ens'

import { renderHook } from '@testing-library/react'

import { useVerifyOphisRecipientName } from './useVerifyOphisRecipientName'

jest.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
jest.mock('../utils/createOphisNameReader', () => ({ createOphisNameReader: () => ({}) }))
jest.mock('@cowprotocol/ens', () => ({
  parseOphisName: (value: string) => (value.endsWith('.eth') ? { name: value } : null),
  verifyOphisNameResolution: jest.fn(),
}))

const EVM = '0x1234567890123456789012345678901234567890'
const SOLANA = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const BITCOIN = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'

beforeEach(() => jest.clearAllMocks())

it.each([
  [AdditionalTargetChainId.SOLANA, SOLANA],
  [AdditionalTargetChainId.BITCOIN, BITCOIN],
  [SupportedChainId.MAINNET, EVM],
])('accepts the unchanged raw recipient for chain %s', async (chain, address) => {
  const { result } = renderHook(() => useVerifyOphisRecipientName())
  await expect(result.current(address, address, chain)).resolves.toBeUndefined()
  expect(verifyOphisNameResolution).not.toHaveBeenCalled()
})

it.each([
  [AdditionalTargetChainId.SOLANA, BITCOIN],
  [AdditionalTargetChainId.BITCOIN, SOLANA],
  [AdditionalTargetChainId.SOLANA, EVM],
  [AdditionalTargetChainId.BITCOIN, EVM],
  [AdditionalTargetChainId.SOLANA, undefined],
  [AdditionalTargetChainId.BITCOIN, ''],
])('rejects missing or wrong-chain recipients for chain %s', async (chain, address) => {
  const { result } = renderHook(() => useVerifyOphisRecipientName())
  await expect(result.current(address, EVM, chain)).rejects.toThrow('Invalid destination recipient address')
})

it('rejects a raw recipient changed before signing', async () => {
  const { result } = renderHook(() => useVerifyOphisRecipientName())
  await expect(result.current(SOLANA, SOLANA.toLowerCase(), AdditionalTargetChainId.SOLANA)).rejects.toThrow(
    'Recipient address changed before signing',
  )
})

it('still verifies Ethereum names, and rejects names on other chains', async () => {
  const { result } = renderHook(() => useVerifyOphisRecipientName())
  await result.current('vitalik.eth', EVM, SupportedChainId.MAINNET)
  expect(verifyOphisNameResolution).toHaveBeenCalledWith({}, 'vitalik.eth', EVM)
  await expect(result.current('vitalik.eth', EVM, AdditionalTargetChainId.SOLANA)).rejects.toThrow()
  await expect(result.current('vitalik.eth', EVM, 10)).rejects.toThrow()
})
