import { CHAIN, CHAIN_ID, CONFIG } from './config'
import { fullWalletForID } from '@railgun-community/wallet'
import type { WalletSession } from './wallet'

export async function unusedSwapAccount(session: WalletSession) {
  await session.accounts.scanHistoryForEphemeralIndex(CONFIG.chain)
  let account = await session.accounts.getCurrentAccount(CHAIN)
  const base = CHAIN_ID === 8453 ? await import('./base-setup') : undefined
  const setup = await base?.savedBaseExecutionSetup(session)
  // Bound recovery work per attempt; retry continues from the last persisted index.
  for (let checked = 0; checked < 1000; checked++) {
    if (setup?.account.toLowerCase() === account.address.toLowerCase() && !setup.cancelled) {
      if (setup.used || (setup.version === 2 && setup.retired)) { account = await session.accounts.getNextAccount(CHAIN); continue }
      if (!setup.confirmed) throw new Error('Check the saved Base account setup before preparing a private operation.')
      if (await base!.baseAccountPrepared(session, account.address)) return account
      throw new Error('The saved Base account setup changed. Check its transaction before preparing another operation.')
    }
    if (base && await base.isBaseSetupAccountReserved(session, account.address)) {
      account = await session.accounts.getNextAccount(CHAIN); continue
    }
    if ((await session.provider.getTransactionCount(account.address, 'pending')) === 0) return account
    account = await session.accounts.getNextAccount(CHAIN)
  }
  throw new Error('Many used temporary accounts found. Request another quote to continue recovery safely.')
}

// Native shielding needs a fresh authorization nonce. Derive a separate account
// without ratcheting past a paid Base setup that belongs to a private operation.
export async function unusedNativeShieldAccount(session: WalletSession) {
  if (CHAIN_ID !== 8453) return unusedSwapAccount(session)
  await session.accounts.scanHistoryForEphemeralIndex(CONFIG.chain)
  const index = await fullWalletForID(session.info.id).getEphemeralKeyIndex(CHAIN)
  const setup = await (await import('./base-setup')).savedBaseExecutionSetup(session)
  for (let checked = 0; checked < 1000; checked++) {
    const candidate = index + checked
    if (candidate === setup?.index) continue
    const account = await session.accounts.getAccount(CHAIN, candidate)
    if (await (await import('./base-setup')).isBaseSetupAccountReserved(session, account.address)) continue
    const [nonce, code] = await Promise.all([
      session.provider.getTransactionCount(account.address, 'pending'), session.provider.getCode(account.address),
    ])
    if (nonce === 0 && code === '0x') return account
  }
  throw new Error('No fresh native deposit account was found. Preserve the saved Base setup and try again later.')
}
