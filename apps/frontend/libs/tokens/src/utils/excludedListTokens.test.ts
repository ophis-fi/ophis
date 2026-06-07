import { isExcludedListToken, LEGACY_OVM_ETH_ADDRESS } from './excludedListTokens'

describe('isExcludedListToken', () => {
  it('excludes the legacy OVM_ETH placeholder (checksummed)', () => {
    expect(isExcludedListToken(LEGACY_OVM_ETH_ADDRESS)).toBe(true)
  })

  it('excludes the legacy OVM_ETH placeholder regardless of case', () => {
    expect(isExcludedListToken('0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000')).toBe(true)
    expect(isExcludedListToken('0xDEADDEADDEADDEADDEADDEADDEADDEADDEAD0000')).toBe(true)
  })

  it('does not exclude the native currency sentinel (0xEeee…EEeE)', () => {
    expect(isExcludedListToken('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(false)
  })

  it('does not exclude regular ERC-20 tokens (USDC, WETH)', () => {
    expect(isExcludedListToken('0x0b2c639c533813f4aa9d7837caf62653d097ff85')).toBe(false)
    expect(isExcludedListToken('0x4200000000000000000000000000000000000006')).toBe(false)
  })
})
