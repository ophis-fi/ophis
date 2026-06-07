import { isExcludedListToken, LEGACY_OVM_ETH_ADDRESS } from './excludedListTokens'

const OPTIMISM = 10
const OPTIMISM_SEPOLIA = 11155420
const MAINNET = 1
const MANTLE = 5000

describe('isExcludedListToken', () => {
  it('excludes the legacy OVM_ETH placeholder on Optimism, any case', () => {
    expect(isExcludedListToken(OPTIMISM, LEGACY_OVM_ETH_ADDRESS)).toBe(true)
    expect(isExcludedListToken(OPTIMISM, '0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000')).toBe(true)
    expect(isExcludedListToken(OPTIMISM, '0xDEADDEADDEADDEADDEADDEADDEADDEADDEAD0000')).toBe(true)
  })

  it('excludes the legacy OVM_ETH placeholder on OP Sepolia', () => {
    expect(isExcludedListToken(OPTIMISM_SEPOLIA, LEGACY_OVM_ETH_ADDRESS)).toBe(true)
  })

  it('does NOT exclude the same address on non-OP-stack chains', () => {
    // The address is only the dead ETH placeholder on the OP stack; on other
    // chains it may be a real listed token, so the exclusion must be scoped.
    expect(isExcludedListToken(MAINNET, LEGACY_OVM_ETH_ADDRESS)).toBe(false)
    expect(isExcludedListToken(MANTLE, LEGACY_OVM_ETH_ADDRESS)).toBe(false)
  })

  it('does not exclude the native sentinel or regular ERC-20s on OP', () => {
    expect(isExcludedListToken(OPTIMISM, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')).toBe(false)
    expect(isExcludedListToken(OPTIMISM, '0x0b2c639c533813f4aa9d7837caf62653d097ff85')).toBe(false)
    expect(isExcludedListToken(OPTIMISM, '0x4200000000000000000000000000000000000006')).toBe(false)
  })
})
