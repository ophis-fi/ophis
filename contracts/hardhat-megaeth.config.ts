// Greg Phase 3 — Hardhat config for deploying CoW core to non-CoW chains
//
// Despite the filename (kept for backwards-compat with the original Phase-3
// MegaETH-only setup), this config layers MegaETH + Hyperliquid HyperEVM
// network entries on top of the upstream cowprotocol/contracts hardhat config.
// Lives inside contracts/ so Node module resolution finds the upstream
// hardhat-deploy / hardhat-waffle / @nomicfoundation packages naturally.
//
// Usage (run from contracts/):
//   HARDHAT_CONFIG=hardhat-megaeth.config.ts \
//     pnpm exec hardhat deploy --network <megaeth-{testnet,mainnet}|hyperevm-{testnet,mainnet}>
//
// Env vars consumed:
//   GREG_MEGAETH_DEPLOYER_PK      : deployer private key (Keychain `greg-megaeth-deployer`)
//   GREG_MEGAETH_DEPLOYER_ADDRESS : deployer EOA address (used as owner+manager override)
//   MEGAETH_TESTNET_RPC           : RPC for chainId 6343
//   MEGAETH_MAINNET_RPC           : RPC for chainId 4326
//   HYPEREVM_TESTNET_RPC          : RPC for chainId 998
//   HYPEREVM_MAINNET_RPC          : RPC for chainId 999

import baseConfig from "./hardhat.config";

const PK = process.env.GREG_MEGAETH_DEPLOYER_PK ?? "";
const accounts = PK ? [PK] : [];

const MEGAETH_TESTNET_RPC =
  process.env.MEGAETH_TESTNET_RPC ?? "https://carrot.megaeth.com/rpc";
const MEGAETH_MAINNET_RPC = process.env.MEGAETH_MAINNET_RPC ?? "";
const HYPEREVM_TESTNET_RPC =
  process.env.HYPEREVM_TESTNET_RPC ?? "https://rpc.hyperliquid-testnet.xyz/evm";
const HYPEREVM_MAINNET_RPC =
  process.env.HYPEREVM_MAINNET_RPC ?? "https://rpc.hyperliquid.xyz/evm";

// CRITICAL OVERRIDE: upstream defaults namedAccounts.owner and .manager to
// the canonical CoW EOA `0x6Fb5916c…1eD` so that the proxy lands at the
// canonical CREATE2 address on every chain. For Greg, that hands control of
// our deploy to CoW's key-holder — they could addSolver/setManager on a
// contract we deployed. We override both to the Greg deployer EOA so we own
// the allowlist on every Greg-target chain. Side-effect: our proxy + Settlement
// land at NEW addresses, distinct from the canonical CoW addresses on every
// other chain. That is the desired behaviour for Greg.
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
    "hyperevm-testnet": {
      url: HYPEREVM_TESTNET_RPC,
      chainId: 998,
      accounts,
      // Big-block opt-in: Settlement deploy ~5M gas exceeds the 3M small-block
      // limit. The deployer EOA must be flagged via HyperCore evmUserModify
      // before running this network's deploy. See infra/hyperevm/README.md.
    },
    "hyperevm-mainnet": {
      url: HYPEREVM_MAINNET_RPC,
      chainId: 999,
      accounts,
    },
    "optimism-sepolia": {
      url: process.env.OP_SEPOLIA_RPC ?? "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts,
    },
    "optimism-mainnet": {
      url: process.env.OP_MAINNET_RPC ?? "https://mainnet.optimism.io",
      chainId: 10,
      accounts,
    },
    "katana-testnet": {
      url: process.env.KATANA_TESTNET_RPC ?? "https://rpc-bokuto.katanarpc.com",
      chainId: 737373,
      accounts,
    },
    "katana-mainnet": {
      url: process.env.KATANA_MAINNET_RPC ?? "https://rpc.katana.network",
      chainId: 747474,
      accounts,
    },
    "mantle-testnet": {
      url: process.env.MANTLE_TESTNET_RPC ?? "https://rpc.sepolia.mantle.xyz",
      chainId: 5003,
      accounts,
    },
    "mantle-mainnet": {
      url: process.env.MANTLE_MAINNET_RPC ?? "https://rpc.mantle.xyz",
      chainId: 5000,
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
      "hyperevm-testnet": GREG_DEPLOYER_ADDRESS,
      "hyperevm-mainnet": GREG_DEPLOYER_ADDRESS,
      "optimism-sepolia": GREG_DEPLOYER_ADDRESS,
      "optimism-mainnet": GREG_DEPLOYER_ADDRESS,
      "katana-testnet": GREG_DEPLOYER_ADDRESS,
      "katana-mainnet": GREG_DEPLOYER_ADDRESS,
      "mantle-testnet": GREG_DEPLOYER_ADDRESS,
      "mantle-mainnet": GREG_DEPLOYER_ADDRESS,
    },
    manager: {
      ...(((baseConfig as { namedAccounts?: { manager?: unknown } })
        .namedAccounts?.manager ?? {}) as Record<string, unknown>),
      "megaeth-testnet": GREG_DEPLOYER_ADDRESS,
      "megaeth-mainnet": GREG_DEPLOYER_ADDRESS,
      "hyperevm-testnet": GREG_DEPLOYER_ADDRESS,
      "hyperevm-mainnet": GREG_DEPLOYER_ADDRESS,
      "optimism-sepolia": GREG_DEPLOYER_ADDRESS,
      "optimism-mainnet": GREG_DEPLOYER_ADDRESS,
      "katana-testnet": GREG_DEPLOYER_ADDRESS,
      "katana-mainnet": GREG_DEPLOYER_ADDRESS,
      "mantle-testnet": GREG_DEPLOYER_ADDRESS,
      "mantle-mainnet": GREG_DEPLOYER_ADDRESS,
    },
  },
};

export default config;
