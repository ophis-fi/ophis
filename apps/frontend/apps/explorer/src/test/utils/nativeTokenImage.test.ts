import { ARC_CHAIN_ID, NATIVE_CURRENCIES, SORTED_CHAIN_IDS } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { existsSync } from 'fs'
import { join } from 'path'

import { NATIVE_TOKEN_ADDRESS } from '../../const'
import { getImageAddress } from '../../utils/miscellaneous'

describe('native token image addresses', () => {
  it.each([...SORTED_CHAIN_IDS, ARC_CHAIN_ID])('uses the shared native currency for chain %s', (chainId) => {
    expect(getImageAddress(NATIVE_TOKEN_ADDRESS, chainId)).toBe(NATIVE_CURRENCIES[chainId].symbol?.toLowerCase())
    const imageAddress = getImageAddress(NATIVE_TOKEN_ADDRESS, chainId)
    const bundledIcon = join(__dirname, '../../assets/img/tokens', `${imageAddress}.png`)
    expect(NATIVE_CURRENCIES[chainId].logoURI || existsSync(bundledIcon)).toBeTruthy()
  })

  it('preserves ERC-20 addresses', () => {
    const address = '0x4200000000000000000000000000000000000006'
    expect(getImageAddress(address, SupportedChainId.MAINNET)).toBe(address)
  })
})
