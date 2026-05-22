import { RPC_URLS } from '@cowprotocol/common-const'
import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { safe, injected } from '@wagmi/connectors'
import { Chain, http } from 'viem'
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  ink,
  linea,
  mainnet,
  optimism,
  plasma,
  polygon,
  sepolia,
} from 'viem/chains'
import { createConfig, Transport } from 'wagmi'

// One-shot scrub of stale wagmi/web3-react persisted state from pre-PR
// #167 sessions. PR #232 fixed the config-time crash, but persisted
// localStorage still hydrates wagmi's `connections` Map with stale
// `chainId: 4326|999` entries. wagmi's `getClient` then calls
// `chains.find(c => c.id === chainId)` on those, finds undefined (because
// PR #167 + PR #232 correctly removed those chains from the runtime list),
// and crashes with "Cannot read properties of undefined (reading 'id')"
// at the `.id` deref a few lines later.
//
// The scrub purges any persisted state referencing 4326 or 999. Cost:
// affected users get re-prompted to connect their wallet ONCE on next
// load. Benefit: the SPA boots. Wallet reconnection re-populates the
// persisted state with a valid chainId.
//
// Idempotent: runs once per cold page load; no-op if storage already
// clean. Wrapped in try/catch because SSR/private-browsing/quota-exceeded
// scenarios shouldn't prevent the SPA from booting at all.
if (typeof window !== 'undefined') {
  try {
    const STORAGE_KEYS = ['wagmi.store', 'wagmi.cache', 'redux_localstorage_simple_user']
    const stalePattern = /"chainId":\s*(?:4326|999)\b/
    for (const key of STORAGE_KEYS) {
      const raw = window.localStorage.getItem(key)
      if (raw && stalePattern.test(raw)) {
        window.localStorage.removeItem(key)
        // eslint-disable-next-line no-console
        console.warn(
          `[ophis] purged stale persisted state at localStorage["${key}"] containing chainId 4326 or 999`,
        )
      }
    }
  } catch {
    // localStorage unavailable (SSR, private browsing, quota) — no-op;
    // the user will hit a fresh state anyway since persistence is unavailable.
  }
}

const SUPPORTED_CHAIN_IDS = Object.values(SupportedChainId).filter((v) => typeof v === 'number')

// Ophis fork: OP mainnet (chain 10) added at frontend layer.
//
// PR #167 (2026-05-21) removed MegaETH (4326) and HyperEVM (999) from
// the FE chain list because those backends aren't production-wired.
// That PR dropped the `SUPPORTED_CHAINS` map entries but LEFT the
// corresponding `*_CHAIN_ID` constants in `ALL_CHAIN_IDS_FOR_WAGMI`.
// Net result: the `chains:` array passed to wagmi's `createConfig`
// contained 2 trailing `undefined` slots. Any wagmi internal hook
// that does `chains.find(c => c.id === chainId)` inside its
// `useSyncExternalStore` selector then dereferenced `c.id` against
// `undefined` and threw — taking the entire SPA down with
// `Cannot read properties of undefined (reading 'id')` on every
// page load.
//
// Fix landed in P0 hotfix 2026-05-22: drop the two dangling chain
// IDs entirely + add `filter(Boolean)` belt-and-suspenders guard at
// the array-build site so the next incomplete sweep can't repeat
// this exact crash mode.
const OPTIMISM_CHAIN_ID = 10 as unknown as SupportedChainId
const ALL_CHAIN_IDS_FOR_WAGMI: SupportedChainId[] = [...SUPPORTED_CHAIN_IDS, OPTIMISM_CHAIN_ID]

const SUPPORTED_CHAINS: Record<SupportedChainId, Chain> = {
  [SupportedChainId.MAINNET]: mainnet,
  [SupportedChainId.BNB]: bsc,
  [SupportedChainId.GNOSIS_CHAIN]: gnosis,
  [SupportedChainId.POLYGON]: polygon,
  [SupportedChainId.BASE]: base,
  [SupportedChainId.PLASMA]: plasma,
  [SupportedChainId.ARBITRUM_ONE]: arbitrum,
  [SupportedChainId.AVALANCHE]: avalanche,
  [SupportedChainId.LINEA]: linea,
  [SupportedChainId.INK]: ink,
  [SupportedChainId.SEPOLIA]: sepolia,
  [OPTIMISM_CHAIN_ID]: optimism,
}

// Defensive guard: `SUPPORTED_CHAINS[chainId]` returns undefined if the
// `chains` map ever drifts out of sync with `ALL_CHAIN_IDS_FOR_WAGMI`
// (see PR #167 incident above). `.filter(Boolean)` ensures any future
// drift surfaces as "this chain isn't actually supported" rather than
// "the entire SPA crashes on load with a cryptic TypeError".
const WAGMI_CHAINS = ALL_CHAIN_IDS_FOR_WAGMI.map((chainId) => SUPPORTED_CHAINS[chainId]).filter(
  (chain): chain is Chain => Boolean(chain),
)

if (WAGMI_CHAINS.length === 0) {
  throw new Error(
    'wagmi config: no supported chains resolved — check SUPPORTED_CHAINS map vs ALL_CHAIN_IDS_FOR_WAGMI',
  )
}

export const config = createConfig({
  chains: WAGMI_CHAINS as [Chain, ...Chain[]],
  transports: ALL_CHAIN_IDS_FOR_WAGMI.reduce(
    (acc, chainId) => {
      const chain = SUPPORTED_CHAINS[chainId]
      if (chain) {
        acc[chainId] = http(RPC_URLS[chainId])
      }
      return acc
    },
    {} as Record<SupportedChainId, Transport>,
  ),
  connectors: [safe(), injected()],
})
