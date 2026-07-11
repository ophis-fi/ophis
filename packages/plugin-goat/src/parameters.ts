import { createToolParameters } from '@goat-sdk/core';
import { z } from 'zod';

export class OphisSwapParameters extends createToolParameters(
  z.object({
    sellToken: z.string().describe('ERC-20 sell token contract address (0x...). Native ETH is NOT supported — use WETH.'),
    buyToken: z.string().describe('ERC-20 buy token contract address (0x...).'),
    sellAmount: z.string().describe('Amount of sellToken to sell, in WHOLE units (e.g. "1.5"), not base units.'),
    slippageBps: z
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional()
      .describe('Max slippage in basis points (default 50 = 0.5%; capped at 5000 = 50%).'),
  }),
) {}
