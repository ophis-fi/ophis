import { Chain, EVM } from '@heyanon/sdk';

const { ChainIds } = EVM.constants;

// The Ophis-supported chains that also exist in the @heyanon/sdk@2.3.1 Chain enum
// (8 of 12). Unichain (130), Linea (59144), Ink (57073) and Plasma (9745) are
// Ophis-supported but ABSENT from this SDK's Chain enum, so they cannot be targeted
// until RealWagmi adds them upstream.
export const supportedChains: number[] = [
  ChainIds[Chain.ETHEREUM],
  ChainIds[Chain.OPTIMISM],
  ChainIds[Chain.BSC],
  ChainIds[Chain.GNOSIS],
  ChainIds[Chain.POLYGON],
  ChainIds[Chain.BASE],
  ChainIds[Chain.ARBITRUM],
  ChainIds[Chain.AVALANCHE],
];
