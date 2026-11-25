/**
 * @jest-environment jsdom
 * @jest-environment-options {"url":"https://swap.ophis.fi/"}
 */
import { readOphisSolanaConfig, SOLANA_DEVNET_GENESIS } from './solana.constants'

jest.mock(
  '@ophis/solana-sdk',
  () => ({
    OPHIS_MAINNET_PROGRAM: 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h',
    solanaAddress: (address: string) => address,
  }),
  { virtual: true },
)

it('pins the production wallet origin, program and genesis before enabling native swaps', () => {
  const original = process.env
  try {
    process.env = {
      ...original,
      REACT_APP_OPHIS_SOLANA_API: 'https://swap.ophis.fi/solana-api',
      REACT_APP_OPHIS_SOLANA_PROGRAM: 'BJZ5yma22Km3fsfrEEdZVGygdrcwoschb6uUNqQWaQ9h',
    }
    expect(readOphisSolanaConfig()?.chain).toBe('solana:mainnet')
    for (const [variable, value] of [
      ['REACT_APP_OPHIS_SOLANA_PROGRAM', '11111111111111111111111111111111'],
      ['REACT_APP_OPHIS_SOLANA_API', 'https://example.org/solana-api'],
      ['REACT_APP_OPHIS_SOLANA_API', 'https://swap.ophis.fi/another-path'],
      ['REACT_APP_OPHIS_SOLANA_GENESIS', SOLANA_DEVNET_GENESIS],
      ['REACT_APP_OPHIS_SOLANA_WALLET_CHAIN', 'solana:devnet'],
    ]) {
      const previous = process.env
      process.env = { ...previous, [variable]: value }
      expect(readOphisSolanaConfig()).toBeNull()
      process.env = previous
    }
  } finally {
    process.env = original
  }
})
