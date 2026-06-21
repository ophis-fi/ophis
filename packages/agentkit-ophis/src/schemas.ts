import { z } from 'zod';

export const OphisSwapSchema = z
  .object({
    sellToken: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .describe('ERC-20 sell token contract address (0x...). Native ETH is NOT supported — use WETH.'),
    buyToken: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .describe('ERC-20 buy token contract address (0x...).'),
    sellAmount: z.string().describe('Amount of sellToken to sell, in WHOLE units (e.g. "1.5"), not base units.'),
    slippageBps: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .nullable()
      .describe('Max slippage in basis points (capped at 5000 = 50%); pass null for the default (50 = 0.5%).'),
  })
  .describe('Swap two ERC-20 tokens via Ophis (a CoW Protocol fork): gasless, MEV-protected intent. The order carries Ophis appData so the integrator earns the rebate.');
