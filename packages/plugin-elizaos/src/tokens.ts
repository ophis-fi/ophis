import { isAddress, getAddress } from 'viem';

/**
 * A SMALL, high-confidence map of canonical token symbols -> address, per chain, so
 * common natural-language requests ("swap USDC for WETH") resolve without the user
 * pasting an address. Anything not here MUST be passed as a 0x address.
 *
 * SECURITY: a wrong address here silently routes funds into the wrong token, so this
 * map is deliberately tiny and every entry is verified. Keep it that way — extend it
 * from an authoritative token list, never from memory.
 */
const CANONICAL: Record<number, Record<string, `0x${string}`>> = {
  // Ethereum
  1: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
  // Optimism
  10: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  // Unichain (OP-stack: WETH is the 0x4200..0006 predeploy; USDC = Circle native,
  // verified on Uniscan + the Ophis unichain infra configs, 2026-07-13)
  130: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  },
  // Polygon
  137: {
    WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  // Base
  8453: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  // Arbitrum
  42161: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
};

/**
 * Resolve a token the LLM extracted (a 0x address OR a known symbol) to a checksummed
 * ERC-20 address for the given chain. Returns undefined if it is neither a valid
 * address nor a known symbol — the caller then asks for the contract address rather
 * than guessing (never let an unresolved token through).
 */
export function resolveToken(input: string, chainId: number): `0x${string}` | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  if (isAddress(raw)) return getAddress(raw);
  const bySymbol = CANONICAL[chainId]?.[raw.toUpperCase()];
  return bySymbol ? getAddress(bySymbol) : undefined;
}
