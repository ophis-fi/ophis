const originalEnv = process.env
const settlement = '0x1111111111111111111111111111111111111111'
const relayer = '0x2222222222222222222222222222222222222222'

function loadArc(values: Record<string, string>): typeof import('./arc.const') {
  jest.resetModules()
  process.env = {
    ...originalEnv,
    NODE_ENV: 'production',
    REACT_APP_ARC_ENABLED: '',
    REACT_APP_ARC_LOCAL: '',
    REACT_APP_ARC_SETTLEMENT: '',
    REACT_APP_ARC_VAULT_RELAYER: '',
    REACT_APP_ARC_ORDERBOOK_URL: '',
    ...values,
  }
  return require('./arc.const')
}

afterEach(() => {
  process.env = originalEnv
})

it('keeps Arc disabled in an ordinary production build', () => {
  expect(loadArc({}).ARC_ENABLED_CHAIN_IDS).toEqual([])
})

const production = {
  REACT_APP_ARC_ENABLED: 'true',
  REACT_APP_ARC_SETTLEMENT: settlement,
  REACT_APP_ARC_VAULT_RELAYER: relayer,
  REACT_APP_ARC_ORDERBOOK_URL: 'https://arc-mainnet.ophis.fi',
}

it('activates Arc with explicit public deployment configuration', () => {
  const arc = loadArc(production)
  expect(arc.ARC_ENABLED_CHAIN_IDS).toEqual([5042])
  expect(arc.ARC_LABEL).toBe('Arc')
  expect(arc.ARC_RPC_URL).toBe('https://rpc.mainnet.arc.io')
})

it.each([
  { REACT_APP_ARC_SETTLEMENT: '' },
  { REACT_APP_ARC_VAULT_RELAYER: settlement },
  { REACT_APP_ARC_LOCAL: 'true' },
  { REACT_APP_ARC_ORDERBOOK_URL: 'http://127.0.0.1:8087' },
  { REACT_APP_ARC_ORDERBOOK_URL: 'https://127.0.0.1' },
  { REACT_APP_ARC_ORDERBOOK_URL: 'https://192.168.1.10' },
  { REACT_APP_ARC_ORDERBOOK_URL: 'https://secret@arc-mainnet.ophis.fi' },
  { REACT_APP_ARC_ORDERBOOK_URL: 'https://arc-mainnet.ophis.fi/?key=secret' },
])('rejects invalid production configuration %o', (override) => {
  expect(() => loadArc({ ...production, ...override })).toThrow()
})
