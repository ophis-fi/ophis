import { beforeEach, expect, it, vi } from 'vitest'
import { calculateGasLimit, EVMGasType } from '@railgun-community/shared-models'
import { parseUnits } from 'ethers'
import type { WalletSession } from './wallet'
import { TOKENS } from './config'

const state = vi.hoisted(() => ({ balance: vi.fn(), estimate: vi.fn(), fee: vi.fn(), refresh: vi.fn(), quote: vi.fn() }))
vi.mock('@railgun-community/wallet', () => ({
  fullWalletForID: () => ({}), balanceForERC20Token: state.balance,
  gasEstimateForUnprovenCrossContractCalls7702: state.estimate,
}))
vi.mock('./wallet', () => ({ requireWalletSync: vi.fn(), refreshReceivedBalances: state.refresh }))
vi.mock('./journal', () => ({ pendingSwap: async () => undefined }))
vi.mock('./withdrawal-journal', () => ({ pendingWithdrawal: async () => undefined }))
vi.mock('./recipe', () => ({ assertQuoteFresh: vi.fn(), quoteSwap: state.quote }))
vi.mock('./account', () => ({ unusedSwapAccount: async () => ({ address: '0x0000000000000000000000000000000000000001' }) }))
vi.mock('./broadcaster', async (original) => ({
  ...await original<typeof import('./broadcaster')>(),
  validateBroadcaster: vi.fn(), broadcasterFee: state.fee,
  gasDetails: async () => ({ evmGasType: EVMGasType.Type4, gasEstimate: 3_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
}))

import { prepareMaxPrivateSwap, preparePrivateSwap } from './private-swap'
const session = { info: { id: 'test-wallet' }, key: 'test-key', provider: { getBlock: async () => ({ baseFeePerGas: 1n }) } } as unknown as WalletSession
const quote = { sell: 'WETH', buy: 'USDC', amount: 1_000_000_000_000_000n, calls: [] } as unknown as Parameters<typeof preparePrivateSwap>[1]
const selected = { tokenAddress: TOKENS.WETH.address, tokenFee: { feePerUnitGas: '1' } } as Parameters<typeof preparePrivateSwap>[2]
const minimumFee = 200_000_000_000_000n
const finalFee = 400_000_000_000_000n

beforeEach(() => {
  state.quote.mockReset().mockImplementation(async (_provider, sell, value, account) => ({ ...quote, sell, amount: parseUnits(value, TOKENS[sell as keyof typeof TOKENS].decimals), account }))
  state.refresh.mockReset().mockResolvedValue(undefined)
  state.balance.mockReset()
  state.estimate.mockReset().mockResolvedValue({ gasEstimate: 6_000_000n })
  state.fee.mockReset().mockReturnValueOnce({ amount: minimumFee }).mockReturnValue({ amount: finalFee })
})

it('reserves the final SDK fee when Max starts with the entire current WETH balance', async () => {
  const balance = parseUnits('0.009975', 18)
  const minimum = parseUnits('0.000589052953882329', 18)
  const final = parseUnits('0.00063', 18)
  state.balance.mockResolvedValue(balance)
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: gas.gasEstimate === 3_000_000n ? minimum : final }))
  const prepared = await prepareMaxPrivateSwap(session, 'WETH', selected)
  expect(prepared.quote.amount).toBe(parseUnits('0.009238683807647088', 18))
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(balance)
  expect(state.quote.mock.calls.map((call) => call[2])).toEqual(['0.009975', '0.009238683807647088'])
  expect(state.estimate).toHaveBeenCalledTimes(1)
})

it('reserves fees using USDC decimals as well as WETH decimals', async () => {
  state.balance.mockResolvedValue(10_000_000n)
  state.fee.mockReset().mockReturnValue({ amount: 1_000_000n })
  const prepared = await prepareMaxPrivateSwap(session, 'USDC', { ...selected, tokenAddress: TOKENS.USDC.address })
  expect(prepared.quote.amount).toBe(8_750_000n)
  expect(state.quote.mock.calls.map((call) => call[2])).toEqual(['10.0', '8.75'])
})

it('keeps trade plus fee within the original budget even if the private balance has increased', async () => {
  const budget = parseUnits('0.009975', 18)
  state.balance.mockResolvedValue(parseUnits('0.02', 18))
  state.fee.mockReset().mockReturnValue({ amount: finalFee })
  const prepared = await prepareMaxPrivateSwap(session, 'WETH', selected, budget)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(budget)
  expect(state.quote.mock.calls.map((call) => call[2])).toEqual(['0.009975', '0.009475'])
  state.fee.mockReturnValue({ amount: budget })
  await expect(prepareMaxPrivateSwap(session, 'WETH', selected, budget)).rejects.toThrow('remaining swap budget')
})

it('keeps the initially observed balance as the Max limit when it grows during preparation', async () => {
  const initial = parseUnits('0.009975', 18)
  state.balance.mockResolvedValueOnce(initial).mockResolvedValue(parseUnits('0.02', 18))
  state.fee.mockReset().mockReturnValue({ amount: finalFee })
  const prepared = await prepareMaxPrivateSwap(session, 'WETH', selected)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(initial)
  expect(state.quote.mock.calls.every((call) => parseUnits(call[2], 18) <= initial)).toBe(true)
})

it('does not invent a Max amount when the broadcaster fee exhausts the balance', async () => {
  state.balance.mockResolvedValue(minimumFee)
  await expect(prepareMaxPrivateSwap(session, 'WETH', selected)).rejects.toThrow('This quoted fee alone uses the entire spendable balance or more')
  expect(state.quote).toHaveBeenCalledTimes(1)
  expect(state.estimate).not.toHaveBeenCalled()
})

it('rounds fee headroom upward and explains when only that margin exceeds the balance', async () => {
  state.balance.mockResolvedValue(6n)
  state.fee.mockReset().mockReturnValue({ amount: 3n })
  const prepared = await prepareMaxPrivateSwap(session, 'USDC', { ...selected, tokenAddress: TOKENS.USDC.address })
  expect(prepared.quote.amount).toBe(2n)
  state.balance.mockResolvedValue(4n)
  await expect(prepareMaxPrivateSwap(session, 'USDC', { ...selected, tokenAddress: TOKENS.USDC.address }))
    .rejects.toThrow('No positive Max swap fits with 25% fee headroom')
})

it('blocks Max with no spendable funds and preserves unrelated estimator errors', async () => {
  state.balance.mockResolvedValueOnce(0n)
  await expect(prepareMaxPrivateSwap(session, 'WETH', selected)).rejects.toThrow('No spendable WETH')
  expect(state.quote).not.toHaveBeenCalled()
  state.balance.mockResolvedValue(quote.amount + finalFee)
  state.estimate.mockRejectedValueOnce(new Error('Unusable gas probe'))
  await expect(prepareMaxPrivateSwap(session, 'WETH', selected)).rejects.toThrow('Unusable gas probe')
})

it('bounds Max recalculation when fees keep rising', async () => {
  state.balance.mockResolvedValue(parseUnits('1', 18))
  let requests = 0n
  state.fee.mockReset().mockImplementation(() => ({ amount: (requests = requests * 2n + 1n) }))
  await expect(prepareMaxPrivateSwap(session, 'WETH', selected)).rejects.toThrow('Balance or broadcaster fee kept changing')
  expect(state.quote).toHaveBeenCalledTimes(4)
})

it('waits for received-note POI status before reading spendable funds', async () => {
  let complete: (() => void) | undefined
  state.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
  state.balance.mockResolvedValue(quote.amount + finalFee)
  const pending = preparePrivateSwap(session, quote, selected)
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  expect(state.balance).not.toHaveBeenCalled()
  complete?.()
  await pending
  expect(state.refresh).toHaveBeenCalledWith(session)
})

it('blocks quoting if the received-balance refresh rejects', async () => {
  state.refresh.mockRejectedValueOnce(new Error('POI refresh unavailable'))
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('POI refresh unavailable')
  expect(state.balance).not.toHaveBeenCalled()
  expect(state.estimate).not.toHaveBeenCalled()
})

it.each([minimumFee - 1n, minimumFee])('explains when the fee alone exhausts the private balance', async (balance) => {
  state.balance.mockResolvedValue(balance)
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('This quoted fee alone uses the entire spendable balance or more')
})

it('explains zero spendable balance before the SDK can emit an opaque dummy-proof fee error', async () => {
  state.balance.mockResolvedValue(0n)
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow(
    'Spendable private balance: 0.0 WETH.\nSwap amount: 0.001 WETH.\nMinimum broadcaster reserve: 0.0002 WETH.\nRequired private balance: at least 0.0012 WETH.',
  )
  expect(state.estimate).not.toHaveBeenCalled()
  expect(state.balance).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), TOKENS.WETH.address, true)
})

it('requires the broadcaster reserve in addition to the swap amount', async () => {
  state.balance.mockResolvedValue(quote.amount)
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('pending deposits do not count')
  expect(state.estimate).not.toHaveBeenCalled()
})

it('rechecks the final higher estimated fee instead of treating the minimum reserve as the quote', async () => {
  state.balance.mockResolvedValue(quote.amount + minimumFee)
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('Required private balance: 0.0014 WETH.')
  expect(state.estimate).toHaveBeenCalledTimes(1)
})

it('allows exact funding of the final fee and checks the updated private balance after estimation', async () => {
  state.balance.mockResolvedValue(quote.amount + finalFee)
  expect(await preparePrivateSwap(session, quote, selected)).toMatchObject({ fee: { amount: finalFee } })
  expect(state.balance).toHaveBeenCalledTimes(2)
  state.balance.mockResolvedValueOnce(quote.amount + finalFee).mockResolvedValueOnce(0n)
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('Spendable private balance: 0.0 WETH.')
})

it('caps the gas price for a fixed 0.0005 WETH trade, then re-estimates without lowering the gas allowance', async () => {
  const balance = 1_216_490_555_332_357n
  const trade = { ...quote, amount: 500_000_000_000_000n }
  const broadcaster = { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } }
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas: 180_000_000n }) } } as unknown as WalletSession
  state.balance.mockResolvedValue(balance)
  state.estimate.mockResolvedValue({ gasEstimate: 3_098_193n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  const prepared = await preparePrivateSwap(current, trade, broadcaster)
  expect(prepared.quote.amount).toBe(trade.amount)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(balance)
  expect(prepared.gas.gasEstimate).toBe(3_100_000n)
  expect(prepared.gas.maxFeePerGas).toBeGreaterThanOrEqual(180_000_001n)
  expect(prepared.gasCapped).toBe(true)
  expect(state.estimate).toHaveBeenCalledTimes(2)
  expect(state.estimate.mock.calls.every((call) => call[12] === 3_000_000n)).toBe(true)
  await expect(preparePrivateSwap(current, { ...trade, amount: 1_000_000_000_000_000n }, broadcaster)).rejects.toThrow('Required private balance')
})

it('rejects a capped quote when the network price rises before the quote is ready', async () => {
  const block = vi.fn().mockResolvedValueOnce({ baseFeePerGas: 180_000_000n }).mockResolvedValue({ baseFeePerGas: 500_000_000n })
  const current = { ...session, provider: { getBlock: block } } as unknown as WalletSession
  state.balance.mockResolvedValue(1_216_490_555_332_357n)
  state.estimate.mockResolvedValue({ gasEstimate: 3_000_000n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  await expect(preparePrivateSwap(current, { ...quote, amount: 500_000_000_000_000n }, { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } }))
    .rejects.toThrow('gas price changed')
})

it('bounds re-estimation if the gas requirement keeps growing after price capping', async () => {
  state.balance.mockResolvedValue(1_216_490_555_332_357n)
  state.estimate.mockResolvedValueOnce({ gasEstimate: 4_000_000n }).mockResolvedValueOnce({ gasEstimate: 5_000_000n }).mockResolvedValueOnce({ gasEstimate: 6_000_000n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  await expect(preparePrivateSwap(session, { ...quote, amount: 500_000_000_000_000n }, { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } }))
    .rejects.toThrow('Gas estimate kept changing')
  expect(state.estimate).toHaveBeenCalledTimes(3)
})

it('blocks an SDK result below the unchanged gas allowance', async () => {
  state.balance.mockResolvedValue(quote.amount + finalFee)
  state.estimate.mockResolvedValue({ gasEstimate: 2_000_000n })
  await expect(preparePrivateSwap(session, quote, selected)).rejects.toThrow('below the required swap allowance')
})

it('retains the largest validated gas estimate when repricing changes the SDK estimate', async () => {
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas: 180_000_000n }) } } as unknown as WalletSession
  state.balance.mockResolvedValue(1_216_490_555_332_357n)
  state.estimate.mockResolvedValueOnce({ gasEstimate: 3_200_000n }).mockResolvedValueOnce({ gasEstimate: 3_100_000n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  const prepared = await preparePrivateSwap(current, { ...quote, amount: 500_000_000_000_000n }, { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } })
  expect(prepared.gas.gasEstimate).toBe(3_200_000n)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(1_216_490_555_332_357n)
})

it('lets Max use a capped price when the recommended price alone would exhaust the balance', async () => {
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas: 180_000_000n }) } } as unknown as WalletSession
  const balance = 1_216_490_555_332_357n
  state.balance.mockResolvedValue(balance)
  state.estimate.mockResolvedValue({ gasEstimate: 3_098_193n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  const prepared = await prepareMaxPrivateSwap(current, 'WETH', { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } })
  expect(prepared.gasCapped).toBe(true)
  expect(prepared.quote.amount).toBeGreaterThan(0n)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(balance)
})

it('prepares Max at a fractional signed rate without rounding its cap below the network price', async () => {
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas: 180_000_000n }) } } as unknown as WalletSession
  const balance = 1_216_490_555_332_357n
  const broadcaster = { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '805304349000000000' } }
  state.balance.mockResolvedValue(balance)
  state.estimate.mockResolvedValue({ gasEstimate: 3_098_193n })
  state.fee.mockReset().mockImplementation((selected, gas) => ({ amount: (BigInt(selected.tokenFee.feePerUnitGas) * calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas) / 10n ** 18n }))
  const prepared = await prepareMaxPrivateSwap(current, 'WETH', broadcaster)
  expect(prepared.gas.maxFeePerGas).toBeGreaterThanOrEqual(180_000_001n)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(balance)
})

it('keeps a Max amount affordable when the network price rises by the reported small amount', async () => {
  let baseFeePerGas = 100_000_000n
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas }) } } as unknown as WalletSession
  const balance = 542_954_230_057_970n
  const broadcaster = { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '805304349000000000' } }
  state.balance.mockResolvedValue(balance)
  state.estimate.mockResolvedValue({ gasEstimate: 3_098_193n })
  state.fee.mockReset().mockImplementation((selected, gas) => ({ amount: (BigInt(selected.tokenFee.feePerUnitGas) * calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas) / 10n ** 18n }))
  const max = await prepareMaxPrivateSwap(current, 'WETH', broadcaster)
  expect(max.gas.maxFeePerGas).toBeGreaterThan(120_000_000n)
  baseFeePerGas = 100_622_999n
  const refreshed = await preparePrivateSwap(current, max.quote, broadcaster)
  expect(refreshed.quote.amount).toBe(max.quote.amount)
  expect(refreshed.quote.amount + refreshed.fee.amount).toBeLessThanOrEqual(balance)
  expect(refreshed.gas.gasEstimate).toBeGreaterThanOrEqual(3_098_193n)
})

it('converges when calldata jitter raises the next SDK estimate by a few gas units', async () => {
  const current = { ...session, provider: { getBlock: async () => ({ baseFeePerGas: 180_000_000n }) } } as unknown as WalletSession
  state.balance.mockResolvedValue(1_216_490_555_332_357n)
  state.estimate.mockResolvedValueOnce({ gasEstimate: 3_098_157n }).mockResolvedValueOnce({ gasEstimate: 3_098_229n })
  state.fee.mockReset().mockImplementation((_selected, gas) => ({ amount: calculateGasLimit(gas.gasEstimate) * gas.maxFeePerGas }))
  const prepared = await preparePrivateSwap(current, { ...quote, amount: 500_000_000_000_000n }, { ...selected, tokenFee: { ...selected.tokenFee, feePerUnitGas: '1000000000000000000' } })
  expect(prepared.gas.gasEstimate).toBe(3_100_000n)
  expect(prepared.quote.amount + prepared.fee.amount).toBeLessThanOrEqual(1_216_490_555_332_357n)
  expect(state.estimate).toHaveBeenCalledTimes(2)
})
