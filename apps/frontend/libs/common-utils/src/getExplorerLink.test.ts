import { ExplorerDataType, getExplorerLink } from './getExplorerLink'

describe('#getExplorerLink', () => {
  it('correct for tx', () => {
    expect(getExplorerLink(1, 'abc', ExplorerDataType.TRANSACTION)).toEqual('https://explorer.ophis.fi/tx/abc')
  })
  it('correct for token', () => {
    expect(getExplorerLink(1, 'abc', ExplorerDataType.TOKEN)).toEqual('https://explorer.ophis.fi/address/abc')
  })
  it('correct for address', () => {
    expect(getExplorerLink(1, 'abc', ExplorerDataType.ADDRESS)).toEqual('https://explorer.ophis.fi/address/abc')
  })
  it('unrecognized chain id defaults to mainnet', () => {
    expect(getExplorerLink(2, 'abc', ExplorerDataType.ADDRESS)).toEqual('https://explorer.ophis.fi/address/abc')
  })
})
