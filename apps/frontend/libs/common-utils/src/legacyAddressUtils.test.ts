import { CHAIN_INFO } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { i18n } from '@lingui/core'

import {
  getBlockExplorerUrl,
  getEtherscanLink,
  getExplorerLabel,
  isAddress,
  shortenAddress,
} from './legacyAddressUtils'

const CONTRACT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
const ORDER_ID = `0x${'ab'.repeat(56)}`
const OPTIMISM = 10 as unknown as SupportedChainId
const UNICHAIN = 130 as unknown as SupportedChainId
const ROBINHOOD = 4663 as unknown as SupportedChainId

describe('explorer links', () => {
  beforeAll(() => {
    i18n.load('en', {})
    i18n.activate('en')
  })

  it.each([
    SupportedChainId.MAINNET,
    SupportedChainId.ARBITRUM_ONE,
    SupportedChainId.BASE,
    SupportedChainId.GNOSIS_CHAIN,
    OPTIMISM,
    UNICHAIN,
    ROBINHOOD,
  ])('contract source links use the native scanner of chain %s with a matching label', (chainId) => {
    const { explorer, explorerTitle } = CHAIN_INFO[chainId]

    expect(explorer).toBeTruthy()
    expect(explorer).not.toContain('explorer.ophis.fi')
    expect(getBlockExplorerUrl(chainId, 'contract', CONTRACT)).toBe(`${explorer}/address/${CONTRACT}#code`)
    expect(getEtherscanLink(chainId, 'contract', CONTRACT)).toBe(`${explorer}/address/${CONTRACT}#code`)
    expect(getExplorerLabel(chainId, 'contract', CONTRACT)).toBe(`View on ${explorerTitle}`)
  })

  it('links Unichain contract source to Uniscan', () => {
    expect(getBlockExplorerUrl(UNICHAIN, 'contract', CONTRACT)).toBe(`https://uniscan.xyz/address/${CONTRACT}#code`)
  })

  it('keeps the explicit explorer base override for contract links', () => {
    expect(getBlockExplorerUrl(SupportedChainId.MAINNET, 'contract', CONTRACT, 'https://custom.scan')).toBe(
      `https://custom.scan/address/${CONTRACT}#code`,
    )
  })

  it('keeps Ophis explorer links and labels for orders, transactions and addresses', () => {
    expect(getEtherscanLink(SupportedChainId.MAINNET, 'transaction', ORDER_ID)).toBe(
      `https://explorer.ophis.fi/orders/${ORDER_ID}`,
    )
    expect(getExplorerLabel(SupportedChainId.MAINNET, 'transaction', ORDER_ID)).toBe('View on Explorer')

    expect(getEtherscanLink(SupportedChainId.MAINNET, 'address', CONTRACT)).toBe(
      `https://explorer.ophis.fi/address/${CONTRACT}`,
    )
    expect(getEtherscanLink(OPTIMISM, 'transaction', '0x1234')).toBe('https://explorer.ophis.fi/opt/tx/0x1234')
    expect(getExplorerLabel(SupportedChainId.MAINNET, 'address', CONTRACT)).toBe('View on Ophis Explorer')
  })
})

describe('utils', () => {
  describe('#isAddress', () => {
    it('returns false if not', () => {
      expect(isAddress('')).toBe(false)
      expect(isAddress('0x0000')).toBe(false)
    })

    it('returns the checksummed address', () => {
      expect(isAddress('0xf164fc0ec4e93095b804a4795bbe1e041497b92a')).toBe('0xf164fC0Ec4E93095b804a4795bBe1e041497b92a')
      expect(isAddress('0xf164fC0Ec4E93095b804a4795bBe1e041497b92a')).toBe('0xf164fC0Ec4E93095b804a4795bBe1e041497b92a')
    })

    it('succeeds even without prefix', () => {
      expect(isAddress('f164fc0ec4e93095b804a4795bbe1e041497b92a')).toBe('0xf164fC0Ec4E93095b804a4795bBe1e041497b92a')
    })
    it('fails if too long', () => {
      expect(isAddress('f164fc0ec4e93095b804a4795bbe1e041497b92a0')).toBe(false)
    })
  })

  describe('#shortenAddress', () => {
    it('throws on invalid address', () => {
      expect(() => shortenAddress('abc')).toThrow("Invalid 'address'")
    })

    it('truncates middle characters', () => {
      expect(shortenAddress('0xf164fc0ec4e93095b804a4795bbe1e041497b92a')).toBe('0xf164...b92a')
    })

    it('renders checksummed address', () => {
      expect(shortenAddress('0x2E1b342132A67Ea578e4E3B814bae2107dc254CC'.toLowerCase())).toBe('0x2E1b...54CC')
    })
  })
})
