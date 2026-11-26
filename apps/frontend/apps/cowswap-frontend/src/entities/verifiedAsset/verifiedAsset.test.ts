import { AdditionalTargetChainId } from '@cowprotocol/cow-sdk'

import contracts from './stockContracts.json'
import { presetVerification, stockIssuer } from './verifiedAsset'

const index = contracts
const nvda = '0xC845B2894DbdDD03858fd2D643B4Ef725fE0849D'

it.each([
  [42161, nvda, 'xStocks'],
  [5042, '0x7042f907266d5ff1c57529d36f9e8c731b569c10', 'bridgedOndo'],
  [5042, '0x14c3abf95cb9c93a8b82c1cdcb76d72cb87b2d4c', undefined],
  [42161, '0x93e62845c1dd5822ebc807ab71a5fb750decd15a', 'wrappedXStocks'],
  [42161, '0xa8ddb5cd96b5222afe198316e9a57caa642850d5', 'wrappedXStocks'],
  [42161, '0x0a85b6ebe3c150a1979a65656e304033d62b1e12', 'reality'],
  [56, '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', 'bStocks'],
  [8453, '0xb200000000000000000000C2e324d24d7eEcd1fb', 'coinbase'],
  [4663, '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', 'robinhood'],
  [AdditionalTargetChainId.SOLANA, 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 'xStocks'],
  [AdditionalTargetChainId.SOLANA, '123mYEnRLM2LLYsJW3K6oyYh8uP1fngj732iG638ondo', 'ondo'],
  [8453, nvda, undefined],
  [42161, '0x0000000000000000000000000000000000000001', undefined],
  [AdditionalTargetChainId.SOLANA, 'xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', undefined],
] as const)('resolves %s/%s from published deployments', (chain, address, issuer) => {
  expect(stockIssuer(index, chain, address)).toBe(issuer)
})

it('scopes native SOL, Circle USDC and Tether USDT to their network and preserves Solana case', () => {
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const chainId = AdditionalTargetChainId.SOLANA
  expect(presetVerification({ chainId, address: 'SOL' })).toBe('native')
  expect(presetVerification({ chainId, address: usdc })).toBe('Circle')
  expect(presetVerification({ chainId, address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })).toBe('Tether')
  expect(presetVerification({ chainId, address: usdc.toLowerCase() })).toBeUndefined()
  expect(presetVerification({ chainId: 8453, address: usdc, symbol: 'USDC' })).toBeUndefined()
  expect(
    presetVerification({
      chainId: 42161,
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      decimals: 6,
    }),
  ).toBe('circleSymbol')
})

it('does not verify a trusted address presented under a different symbol', () => {
  expect(stockIssuer(index, 42161, nvda, 'USDC')).toBe('mismatch')
  expect(stockIssuer(index, 42161, nvda, 'NVDAX')).toBe('xStocks')
})

it.each([
  [1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 'circleSymbol'],
  [8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 'circleSymbol'],
  [56, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', undefined],
  [43114, '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 'USDT', 'Tether'],
  [43114, '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', 'USDC', 'mismatch'],
  [1, '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 'PYUSD', 'Paxos'],
  [1, '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2', 'EURCV', 'SG-FORGE'],
  [1, '0x8292bb45bf1ee4d140127049757c2e0ff06317ed', 'RLUSD', 'Ripple Custody & Trust Co.'],
  [AdditionalTargetChainId.SOLANA, 'So11111111111111111111111111111111111111112', 'SOL', undefined],
  [42161, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT', undefined],
  [56, '0x55d398326f99059fF775485246999027B3197955', 'USDT', undefined],
  [56, '0x55d398326f99059fF775485246999027B3197955', 'USDC', undefined],
  [10, '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 'USDC.e', undefined],
] as const)('identifies the canonical or bridged %s/%s/%s deployment', (chainId, address, symbol, expected) => {
  expect(presetVerification({ chainId, address, symbol, decimals: 6 })).toBe(expected)
})

it.each([
  [1, 'ETH'],
  [56, 'BNB'],
  [43114, 'AVAX'],
] as const)('identifies the actual native coin on %s', (chainId, symbol) => {
  const native = { chainId, symbol, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }
  expect(presetVerification(native)).toBe('native')
  expect(presetVerification({ ...native, address: '0x0000000000000000000000000000000000000001' })).toBeUndefined()
})
