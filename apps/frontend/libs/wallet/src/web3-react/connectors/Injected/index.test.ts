import type { Actions } from '@web3-react/types'

import { InjectedWallet } from './index'

it('does not reset an already eager-connected session when connectEagerly runs again', async () => {
  const actions: Actions = { startActivation: jest.fn(() => () => undefined), update: jest.fn(), resetState: jest.fn() }
  const connector = new InjectedWallet({ actions, walletUrl: '', searchKeywords: [] })
  connector.eagerConnection = true

  await connector.connectEagerly()

  expect(actions.startActivation).not.toHaveBeenCalled()
  expect(actions.resetState).not.toHaveBeenCalled()
})
