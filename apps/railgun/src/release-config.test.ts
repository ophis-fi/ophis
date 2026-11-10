import { afterEach, expect, it, vi } from 'vitest'
import { validateRailgunAddress } from '@railgun-community/wallet'
import { CONFIG, FEE_SIGNER, PREPAID_BROADCASTERS, PREPAID_OPERATOR, PROTECTED_BROADCASTERS, TOKENS } from './config'
import { assertSubmittable, validateBroadcaster } from './broadcaster'
import { EVMGasType, type SelectedBroadcaster } from '@railgun-community/shared-models'
import type { WalletSession } from './wallet'

vi.mock('./config', async (original) => ({ ...await original<typeof import('./config')>(), ENVIRONMENT: 'ethereum' }))
afterEach(() => vi.restoreAllMocks())

it('pins native Ethereum and BNB prepayment to the owner identity and approved limits', () => {
  const protectedRoute = PROTECTED_BROADCASTERS[1]![0]
  expect(PREPAID_BROADCASTERS[1]).toEqual({ ...protectedRoute, operator: PREPAID_OPERATOR, funding: 'native' })
  expect(PREPAID_BROADCASTERS[56]).toEqual({ operator: PREPAID_OPERATOR, railgunAddress: FEE_SIGNER, funding: 'native',
    expiresAt: protectedRoute.expiresAt, maxGasPrice: 100_000_000n, maxTransactionCost: 250_000_000_000_000n })
})

it('binds Ethereum discovery and protection to the reviewed Ophis fee identity with an explicit review expiry', () => {
  expect(validateRailgunAddress(FEE_SIGNER)).toBe(true)
  expect(FEE_SIGNER).toBe('0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f')
  expect(Object.keys(PROTECTED_BROADCASTERS)).toEqual(['1'])
  expect(PROTECTED_BROADCASTERS[1]).toEqual([
    { railgunAddress: FEE_SIGNER, expiresAt: Date.parse('2026-11-13T00:00:00Z'),
      maxGasPrice: 1_000_000_000n, maxTransactionCost: 3_000_000_000_000_000n },
  ])
})

it.each([true, false])('rejects retired fee identity for delegated=%s submissions', (delegated) => {
  const selected = { railgunAddress: '0zk1qyjex88m96zw2kunzxw8r8g7007ak2qe082w5n0f038chhhkzfcdtrv7j6fe3z53law92j4q28j34xsacfqf9kmqw20ap8ek904q7j0hjllh8rpd3t96jq7xh98',
    tokenAddress: TOKENS.USDC.address } as SelectedBroadcaster
  expect(() => validateBroadcaster(selected, selected.tokenAddress, delegated)).toThrow(/reviewed Ophis fee identity/)
})

it('preserves common withdrawals after swap approval expiry with the pinned identity and gas caps', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T00:00:00Z'))
  const session = { provider: { send: async () => undefined, getNetwork: async () => ({ chainId: 1n }) } } as unknown as WalletSession
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.USDC.address,
    tokenFee: { feePerUnitGas: '1150000000000000000', expiration: Date.now() + 600_000 } } as SelectedBroadcaster
  await expect(assertSubmittable(session, selected,
    { evmGasType: EVMGasType.Type1, gasEstimate: 100_000n, gasPrice: 100_000_000n })).resolves.toBeUndefined()
  await expect(assertSubmittable(session, selected,
    { evmGasType: EVMGasType.Type1, gasEstimate: 100_000n, gasPrice: 1_100_000_000n })).rejects.toThrow(/broadcaster limits/)
})

it.each(['price', 'budget', 'valid'])('checks the reviewed %s limit before a proof or submission', async (condition) => {
  const read = vi.fn(async () => undefined)
  const session = { provider: { send: read, getNetwork: async () => ({ chainId: 1n }),
    getBlock: async () => ({ baseFeePerGas: 100_000_000n }) } } as unknown as WalletSession
  const selected = { railgunAddress: FEE_SIGNER, tokenAddress: TOKENS.WETH.address,
    tokenFee: { feePerUnitGas: '1150000000000000000', expiration: Date.now() + 600_000,
      relayAdapt7702: CONFIG.relayAdapt7702Contract } } as SelectedBroadcaster
  const gas = { evmGasType: EVMGasType.Type4 as const, gasEstimate: condition === 'price' ? 100_000n : condition === 'budget' ? 8_000_000n : 3_000_000n,
    maxFeePerGas: condition === 'price' ? 1_100_000_000n : 400_000_000n, maxPriorityFeePerGas: 1n }
  if (condition === 'valid') await expect(assertSubmittable(session, selected, gas)).resolves.toBeUndefined()
  else {
    await expect(assertSubmittable(session, selected, gas)).rejects.toThrow(/exceeds the Ophis broadcaster limits/)
    expect(read).not.toHaveBeenCalled()
  }
  if (condition !== 'valid') await expect(assertSubmittable(session, selected, {
    evmGasType: EVMGasType.Type1, gasEstimate: gas.gasEstimate, gasPrice: gas.maxFeePerGas,
  })).rejects.toThrow(/exceeds the Ophis broadcaster limits/)
})
