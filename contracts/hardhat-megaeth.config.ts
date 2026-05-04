// Greg Phase 3 — Hardhat config for deploying to MegaETH
//
// Lives inside contracts/ so Node module resolution finds the upstream
// hardhat-deploy / hardhat-waffle / @nomicfoundation packages naturally.
// Imports the upstream config as a base and only swaps the networks
// block. This file is Greg-owned; future `git subtree pull` of upstream
// will not touch it (new file, not in upstream tree).
//
// Usage (run from contracts/):
//   HARDHAT_CONFIG=hardhat-megaeth.config.ts \
//     pnpm exec hardhat deploy --network <megaeth-testnet|megaeth-mainnet>
//
// Env vars consumed:
//   GREG_MEGAETH_DEPLOYER_PK : deployer private key (from Keychain
//                              entry `greg-megaeth-deployer`)
//   MEGAETH_TESTNET_RPC      : RPC URL for chainId 6342
//   MEGAETH_MAINNET_RPC      : RPC URL for chainId 4326

import baseConfig from "./hardhat.config";

const PK = process.env.GREG_MEGAETH_DEPLOYER_PK ?? "";
const accounts = PK ? [PK] : [];

const MEGAETH_TESTNET_RPC =
  process.env.MEGAETH_TESTNET_RPC ?? "https://carrot.megaeth.com/rpc";
const MEGAETH_MAINNET_RPC = process.env.MEGAETH_MAINNET_RPC ?? "";

// CRITICAL OVERRIDE: upstream defaults namedAccounts.owner and .manager to
// the canonical CoW EOA `0x6Fb5916c…1eD` so that the proxy lands at the
// canonical CREATE2 address on every chain. For Greg, that hands control of
// our deploy to CoW's key-holder — they could addSolver/setManager on a
// contract we deployed. We override both to the Greg deployer EOA so we own
// the allowlist on MegaETH (testnet 6343 + mainnet 4326). Side-effect: our
// proxy + Settlement land at NEW addresses, distinct from the canonical CoW
// addresses on every other chain. That is the desired behaviour for Greg.
const GREG_DEPLOYER_ADDRESS = process.env.GREG_MEGAETH_DEPLOYER_ADDRESS ?? "";

const config = {
  ...baseConfig,
  networks: {
    ...((baseConfig as { networks?: Record<string, unknown> }).networks ?? {}),
    "megaeth-testnet": {
      url: MEGAETH_TESTNET_RPC,
      // 6343 (0x18c7) — the live MegaETH testnet at carrot.megaeth.com/rpc.
      // Chain 6342 (0x18c6) on Chainlist is the previous, deprecated testnet.
      chainId: 6343,
      accounts,
    },
    "megaeth-mainnet": {
      url: MEGAETH_MAINNET_RPC,
      chainId: 4326,
      accounts,
    },
  },
  namedAccounts: {
    ...((baseConfig as { namedAccounts?: Record<string, unknown> })
      .namedAccounts ?? {}),
    owner: {
      ...(((baseConfig as { namedAccounts?: { owner?: unknown } })
        .namedAccounts?.owner ?? {}) as Record<string, unknown>),
      "megaeth-testnet": GREG_DEPLOYER_ADDRESS,
      "megaeth-mainnet": GREG_DEPLOYER_ADDRESS,
    },
    manager: {
      ...(((baseConfig as { namedAccounts?: { manager?: unknown } })
        .namedAccounts?.manager ?? {}) as Record<string, unknown>),
      "megaeth-testnet": GREG_DEPLOYER_ADDRESS,
      "megaeth-mainnet": GREG_DEPLOYER_ADDRESS,
    },
  },
};

export default config;
