import {
  NATIVE_CURRENCIES,
  WRAPPED_NATIVE_CURRENCIES,
  HYPERCORE_CHAIN_ID,
  MONAD_CHAIN_ID,
} from '@cowprotocol/common-const'
import { AdditionalTargetChainId, ALL_SUPPORTED_CHAINS_MAP, SupportedChainId } from '@cowprotocol/cow-sdk'

import { getBridgeTokenLogo } from './bridgeTokenLogo.utils'

it('retains SDK native artwork and reuses canonical wrapped-token metadata', () => {
  for (const chainId of [SupportedChainId.POLYGON, SupportedChainId.GNOSIS_CHAIN, SupportedChainId.PLASMA]) {
    const native = NATIVE_CURRENCIES[chainId]
    expect(native.logoURI).toBe(ALL_SUPPORTED_CHAINS_MAP[chainId].nativeCurrency.logoUrl)
    expect(getBridgeTokenLogo(chainId, native.address)).toBeTruthy()
  }
  const wrapped = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.MAINNET]
  expect(getBridgeTokenLogo(wrapped.chainId, wrapped.address)).toBe(wrapped.logoURI)
})

it('resolves verified aliases and artwork omitted from the symbol registry by exact identity', () => {
  const examples: Array<[number, string, string]> = [
    [AdditionalTargetChainId.SOLANA, 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'wif.svg'],
    [AdditionalTargetChainId.SOLANA, 'CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn', 'btc.svg'],
    [AdditionalTargetChainId.SOLANA, '3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG', 'near.svg'],
    [HYPERCORE_CHAIN_ID, '0x20b8c9d2f022ffd2aea4f7962b7b1d8b', 'near.svg'],
    [MONAD_CHAIN_ID, '0xe7cd86e13ac4309349f30b3435a9d337750fc82d', 'usdt.png'],
    [4663, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'usdg.svg'],
    [SupportedChainId.MAINNET, '0x68749665ff8d2d112fa859aa293f07a622782f38', 'xaut.png'],
    [AdditionalTargetChainId.SOLANA, 'J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr', 'spx.png'],
  ]
  for (const [chainId, address, artwork] of examples) {
    expect(getBridgeTokenLogo(chainId, address)).toBe(`/logos/token-${artwork}`)
  }
})

it('uses verified remote metadata for assets without bundled artwork', () => {
  expect(getBridgeTokenLogo(AdditionalTargetChainId.SOLANA, 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82')).toMatch(
    /^https:\/\/coin-images\.coingecko\.com\//,
  )
})

it('requires the correct chain and case-sensitive non-EVM identity for canonical artwork', () => {
  const solanaUsdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  expect(getBridgeTokenLogo(AdditionalTargetChainId.SOLANA, solanaUsdc.toLowerCase())).toBeUndefined()
  expect(getBridgeTokenLogo(HYPERCORE_CHAIN_ID, solanaUsdc)).toBeUndefined()
  expect(getBridgeTokenLogo(MONAD_CHAIN_ID, '0x1111111111111111111111111111111111111111')).toBeUndefined()
  expect(getBridgeTokenLogo(MONAD_CHAIN_ID, '0x754704BC059F8C67012FED69BC8A327A5AAFB603')).toBe('/logos/token-usdc.png')
})
