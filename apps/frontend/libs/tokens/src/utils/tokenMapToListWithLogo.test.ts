import { tokenMapToListWithLogo } from './tokenMapToListWithLogo'

test('current lists override stale saved metadata without mutating the saved token or losing tags', () => {
  const address = '0x7042f907266d5ff1c57529d36f9e8c731b569c10'
  const saved = { chainId: 5042, address, decimals: 18, symbol: 'AAPLon', name: 'Old name', tags: ['saved'] }
  const listed = {
    ...saved,
    name: 'Apple (Ondo Tokenized)',
    logoURI: 'https://swap.ophis.fi/logos/token-aaplon.png',
    tags: ['ondo'],
  }
  const tokens = tokenMapToListWithLogo(
    [{ [address]: saved }, { [address.toUpperCase().replace('0X', '0x')]: listed }],
    5042,
  )
  expect(tokens).toHaveLength(1)
  expect(tokens[0]).toMatchObject({ ...listed, tags: ['saved', 'ondo'] })
  expect(saved.tags).toEqual(['saved'])
  expect(saved.name).toBe('Old name')
  expect(tokenMapToListWithLogo([{ [address]: listed }, { [address]: saved }], 5042)[0].logoURI).toBe(listed.logoURI)
})
