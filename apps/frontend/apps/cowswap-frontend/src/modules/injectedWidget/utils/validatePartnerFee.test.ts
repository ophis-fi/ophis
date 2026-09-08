import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { TradeType } from '@cowprotocol/widget-lib'

import { validatePartnerFee } from './validatePartnerFee'

import { PARTNER_FEE_MAX_BPS } from '../consts'

describe('validatePartnerFee()', () => {
  it(`When BPS is higher than ${PARTNER_FEE_MAX_BPS}, then should return error`, () => {
    const result = validatePartnerFee({
      bps: 200,
      recipient: '0x0000000000000000000000000000000000000000',
    })

    expect(result).toEqual(['Partner fee can not be more than 90 BPS!'])
  })

  it('When BPS is less than zero, then should return error', () => {
    const result = validatePartnerFee({
      bps: -1,
      recipient: '0x0000000000000000000000000000000000000000',
    })

    expect(result).toEqual(['Partner fee can not be less than 0!'])
  })

  it('When recipient is empty, then should return error', () => {
    const result = validatePartnerFee({
      bps: 90,
      recipient: '',
    })

    expect(result).toEqual(['Partner fee recipient must be set!'])
  })

  describe('When recipient is a string', () => {
    it('When recipient is not a valid address, then should return error', () => {
      const result = validatePartnerFee({
        bps: 90,
        recipient: 'asvbfbdf',
      })

      expect(result).toEqual([
        'invalid address (argument="address", value="asvbfbdf", code=INVALID_ARGUMENT, version=address/5.7.0)',
      ])
    })

    it('When the recipient is valid, then should return undefined', () => {
      const result = validatePartnerFee({
        bps: 90,
        recipient: '0x0000000000000000000000000000000000000000',
      })

      expect(result).toBe(undefined)
    })
  })

  describe('When bps is a map', () => {
    it('When one of bps is not a valid, then should return error', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: 200,
          [SupportedChainId.ARBITRUM_ONE]: 90,
          [SupportedChainId.GNOSIS_CHAIN]: 90,
          [SupportedChainId.SEPOLIA]: 90,
        },
        recipient: '0x0000000000000000000000000000000000000000',
      })

      expect(result).toEqual(['Partner fee can not be more than 90 BPS!'])
    })

    it('When all bps are valid, then should return undefined', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: 90,
          [SupportedChainId.ARBITRUM_ONE]: 90,
          [SupportedChainId.GNOSIS_CHAIN]: 90,
          [SupportedChainId.SEPOLIA]: 90,
        },
        recipient: '0x0000000000000000000000000000000000000000',
      })

      expect(result).toBe(undefined)
    })

    it('Per trade type and per network config', () => {
      const result = validatePartnerFee({
        bps: {
          [TradeType.SWAP]: {
            [SupportedChainId.MAINNET]: 90,
            [SupportedChainId.ARBITRUM_ONE]: 90,
            [SupportedChainId.GNOSIS_CHAIN]: 90,
            [SupportedChainId.SEPOLIA]: 90,
          },
          [TradeType.LIMIT]: {
            [SupportedChainId.MAINNET]: 90,
            [SupportedChainId.ARBITRUM_ONE]: 90,
            [SupportedChainId.GNOSIS_CHAIN]: -1,
            [SupportedChainId.SEPOLIA]: 90,
          },
          [TradeType.ADVANCED]: {
            [SupportedChainId.MAINNET]: 90,
            [SupportedChainId.ARBITRUM_ONE]: 90,
            [SupportedChainId.GNOSIS_CHAIN]: 90,
            [SupportedChainId.SEPOLIA]: 90,
          },
        },
        recipient: '0x0000000000000000000000000000000000000000',
      })

      expect(result).toEqual(['Partner fee can not be less than 0!'])
    })

    it('Per network and per trade type config', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: {
            [TradeType.SWAP]: 90,
            [TradeType.LIMIT]: 90,
            [TradeType.ADVANCED]: 90,
          },
          [SupportedChainId.ARBITRUM_ONE]: {
            [TradeType.SWAP]: 90,
            [TradeType.LIMIT]: 90,
            [TradeType.ADVANCED]: 90,
          },
          [SupportedChainId.GNOSIS_CHAIN]: {
            [TradeType.SWAP]: 90,
            [TradeType.LIMIT]: -2,
            [TradeType.ADVANCED]: 90,
          },
          [SupportedChainId.SEPOLIA]: {
            [TradeType.SWAP]: 90,
            [TradeType.LIMIT]: 90,
            [TradeType.ADVANCED]: 90,
          },
        },
        recipient: '0x0000000000000000000000000000000000000000',
      })

      expect(result).toEqual(['Partner fee can not be less than 0!'])
    })
  })

  describe('When recipient is a map', () => {
    it('When one of addresses is not a valid address, then should return error', () => {
      const result = validatePartnerFee({
        bps: 90,
        recipient: {
          [SupportedChainId.MAINNET]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.ARBITRUM_ONE]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.GNOSIS_CHAIN]: 'rtrth',
          [SupportedChainId.SEPOLIA]: '0x0000000000000000000000000000000000000000',
        },
      })

      expect(result).toEqual([
        'invalid address (argument="address", value="rtrth", code=INVALID_ARGUMENT, version=address/5.7.0)',
      ])
    })

    it('When all addresses are valid, then should return undefined', () => {
      const result = validatePartnerFee({
        bps: 90,
        recipient: {
          [SupportedChainId.MAINNET]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.ARBITRUM_ONE]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.GNOSIS_CHAIN]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.SEPOLIA]: '0x0000000000000000000000000000000000000000',
        },
      })

      expect(result).toBe(undefined)
    })
  })

  describe('When bps and recipient are maps', () => {
    it('When one of bps is not a valid, then should return error', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: 200,
          [SupportedChainId.ARBITRUM_ONE]: 90,
          [SupportedChainId.GNOSIS_CHAIN]: 90,
          [SupportedChainId.SEPOLIA]: 90,
        },
        recipient: {
          [SupportedChainId.MAINNET]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.ARBITRUM_ONE]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.GNOSIS_CHAIN]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.SEPOLIA]: '0x0000000000000000000000000000000000000000',
        },
      })

      expect(result).toEqual(['Partner fee can not be more than 90 BPS!'])
    })

    it('When one of addresses is not a valid address, then should return error', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: 90,
          [SupportedChainId.ARBITRUM_ONE]: 90,
          [SupportedChainId.GNOSIS_CHAIN]: 90,
          [SupportedChainId.SEPOLIA]: 90,
        },
        recipient: {
          [SupportedChainId.MAINNET]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.ARBITRUM_ONE]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.GNOSIS_CHAIN]: 'rtrth',
          [SupportedChainId.SEPOLIA]: '0x0000000000000000000000000000000000000000',
        },
      })

      expect(result).toEqual([
        'invalid address (argument="address", value="rtrth", code=INVALID_ARGUMENT, version=address/5.7.0)',
      ])
    })

    it('When everything is valid, then should return undefined', () => {
      const result = validatePartnerFee({
        bps: {
          [SupportedChainId.MAINNET]: 90,
          [SupportedChainId.ARBITRUM_ONE]: 90,
          [SupportedChainId.GNOSIS_CHAIN]: 90,
          [SupportedChainId.SEPOLIA]: 90,
        },
        recipient: {
          [SupportedChainId.MAINNET]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.ARBITRUM_ONE]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.GNOSIS_CHAIN]: '0x0000000000000000000000000000000000000000',
          [SupportedChainId.SEPOLIA]: '0x0000000000000000000000000000000000000000',
        },
      })

      expect(result).toBe(undefined)
    })
  })

  it('rejects the Ophis Safe as recipient: the Ophis fee is stacked automatically', () => {
    const result = validatePartnerFee({
      bps: 50,
      recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
    })

    expect(result).toEqual([
      'Partner fee recipient must be your own address: the Ophis fee is added automatically on top of yours.',
    ])
  })

  it('accepts a 90 BPS host fee and rejects 91 (the stacked aggregate cap)', () => {
    const ok = validatePartnerFee({ bps: 90, recipient: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' })
    const tooHigh = validatePartnerFee({ bps: 91, recipient: '0x40d5faafb4540fb1f8f0af5b293425d11cd07fb4' })

    expect(ok).toBe(undefined)
    expect(tooHigh).toEqual(['Partner fee can not be more than 90 BPS!'])
  })
})
