import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { RPC_URLS, WALLET_RPC_URLS } from './networks'

describe('WALLET_RPC_URLS: keyless public endpoints handed to wallets', () => {
  it('covers exactly the same chains as RPC_URLS', () => {
    expect(Object.keys(WALLET_RPC_URLS).sort()).toEqual(Object.keys(RPC_URLS).sort())
  })

  it.each(Object.entries(WALLET_RPC_URLS))('chain %s is a keyless https endpoint', (_chainId, url) => {
    expect(url).toMatch(/^https:\/\//)
    // No keyed provider URL may reach a wallet: Alchemy/Infura key paths or an api-key query.
    expect(url).not.toMatch(/alchemy|infura|\/v[23]\/[A-Za-z0-9_-]{8,}|[?&](api[_-]?key|key)=/i)
  })
})

describe('WALLET_RPC_URLS ignores the keyed env override', () => {
  const ENV_KEY = 'REACT_APP_NETWORK_URL_1'
  const original = process.env[ENV_KEY]

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = original
    jest.resetModules()
  })

  it('mainnet stays on the keyless public default even when a keyed override is set', () => {
    const keyed = 'https://eth-mainnet.g.alchemy.com/v2/pretend-secret-key'
    process.env[ENV_KEY] = keyed
    jest.resetModules()

    const reloaded = require('./networks')
    // Our own reads honour the override...
    expect(reloaded.RPC_URLS[SupportedChainId.MAINNET]).toBe(keyed)
    // ...but the wallet-facing map never does.
    expect(reloaded.WALLET_RPC_URLS[SupportedChainId.MAINNET]).not.toBe(keyed)
    expect(reloaded.WALLET_RPC_URLS[SupportedChainId.MAINNET]).not.toMatch(/alchemy|\/v2\//)
    expect(reloaded.WALLET_RPC_URLS[SupportedChainId.MAINNET]).toMatch(/^https:\/\//)
  })
})
