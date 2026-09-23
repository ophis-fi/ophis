export const solverNames = ['Horadrim', 'Tsolver', 'OKX'];
export const venueSets = {
  Ethereum: [['Uniswap', '/logos/swap-story/uniswap.svg'], ['Curve', '/logos/swap-story/curve.png'], ['SushiSwap', '/logos/swap-story/sushi.svg']],
  Base: [['Uniswap', '/logos/swap-story/uniswap.svg'], ['Aerodrome', '/logos/swap-story/aerodrome.png'], ['SushiSwap', '/logos/swap-story/sushi.svg']],
};
export const tokens = {USDC: '/logos/swap-story/usdc.svg', ETH: '/logos/swap-story/ethereum.svg', SOL: '/logos/swap-story/solana.svg', AAPLc: '/logos/swap-story/AAPLc.png', NVDAc: '/logos/swap-story/NVDAc.png'};
export const chains = {Ethereum: '/logos/swap-story/ethereum.svg', Solana: '/logos/swap-story/solana.svg', Base: '/logos/swap-story/base.png'};
export const examples: [keyof typeof tokens, keyof typeof tokens, keyof typeof venueSets, keyof typeof chains, string][] = [
  ['USDC', 'SOL', 'Ethereum', 'Solana', 'Crosschain'],
  ['ETH', 'USDC', 'Ethereum', 'Ethereum', 'Same-chain swap'],
  ['USDC', 'AAPLc', 'Base', 'Base', 'Tokenized stocks'],
  ['USDC', 'ETH', 'Base', 'Ethereum', 'Crosschain'],
  ['USDC', 'NVDAc', 'Base', 'Base', 'Tokenized stocks'],
];
export const duration = 4800;
