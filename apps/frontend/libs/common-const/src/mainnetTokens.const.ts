import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { TokenWithLogo } from './types'

export const AAPLON_MAINNET = new TokenWithLogo(
  'https://swap.ophis.fi/logos/token-aaplon.png',
  SupportedChainId.MAINNET,
  '0x14c3abF95Cb9C93a8b82C1CdCB76D72Cb87b2d4c',
  18,
  'AAPLon',
  'Apple (Ondo Tokenized)',
)

export const AMZNON_MAINNET = new TokenWithLogo(
  'https://swap.ophis.fi/logos/token-amznon.png',
  SupportedChainId.MAINNET,
  '0xbb8774FB97436d23d74C1b882E8E9A69322cFD31',
  18,
  'AMZNon',
  'Amazon (Ondo Tokenized)',
)

export const NVDAON_MAINNET = new TokenWithLogo(
  'https://swap.ophis.fi/logos/token-nvdaon.png',
  SupportedChainId.MAINNET,
  '0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE',
  18,
  'NVDAon',
  'NVIDIA (Ondo Tokenized)',
)

export const EURC_MAINNET = new TokenWithLogo(
  'https://swap.ophis.fi/logos/token-eurc.png',
  SupportedChainId.MAINNET,
  '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
  6,
  'EURC',
  'EURC',
)
