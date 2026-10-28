import { CHAIN, CONFIG } from './config'
import type { WalletSession } from './wallet'

export async function unusedSwapAccount(session: WalletSession) {
  await session.accounts.scanHistoryForEphemeralIndex(CONFIG.chain)
  let account = await session.accounts.getCurrentAccount(CHAIN)
  // Bound recovery work per attempt; retry continues from the last persisted index.
  for (let checked = 0; checked < 1000; checked++) {
    if ((await session.provider.getTransactionCount(account.address, 'pending')) === 0) return account
    account = await session.accounts.getNextAccount(CHAIN)
  }
  throw new Error('Many used temporary accounts found. Request another quote to continue recovery safely.')
}
