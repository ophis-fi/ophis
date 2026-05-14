// Ophis — Hardhat config for deploying CoW core to non-CoW chains
//
// Layers Ophis-target network entries on top of the upstream
// cowprotocol/contracts hardhat config. Lives inside contracts/ so Node
// module resolution finds the upstream hardhat-deploy / hardhat-waffle /
// @nomicfoundation packages naturally.
//
// Usage (run from contracts/):
//   HARDHAT_CONFIG=hardhat-megaeth.config.ts \
//     pnpm exec hardhat deploy --network <megaeth-{testnet,mainnet}|hyperevm-{testnet,mainnet}|optimism-{sepolia,mainnet}|...>
//
// Mainnet networks (`megaeth-mainnet`, `optimism-mainnet`) use the
// `@nomicfoundation/hardhat-ledger` plugin and route signing requests
// through the connected Ledger at OPHIS_HW_WALLET. Ledger Live must be
// closed during deploys (USB device contention).
//
// Testnet networks use the legacy Keychain-software-key flow.
//
// Env vars consumed:
//   OPHIS_MEGAETH_DEPLOYER_PK : deployer private key (Keychain `ophis-megaeth-deployer`)
//                               TESTNETS ONLY — mainnets sign via Ledger.
//   MEGAETH_TESTNET_RPC       : RPC for chainId 6343
//   MEGAETH_MAINNET_RPC       : RPC for chainId 4326
//   HYPEREVM_TESTNET_RPC      : RPC for chainId 998
//   HYPEREVM_MAINNET_RPC      : RPC for chainId 999
//   OP_SEPOLIA_RPC            : RPC for chainId 11155420
//   OP_MAINNET_RPC            : RPC for chainId 10

import "@nomicfoundation/hardhat-ledger";
import baseConfig from "./hardhat.config";

// Clement's primary HW wallet (Ledger). Signs all mainnet deploys + owns
// AllowListAuthentication for ~30 seconds between deploy and
// transferOwnership(<Ophis protocol Safe 0xe049a645…01cF>).
const OPHIS_HW_WALLET = "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199";

const PK = process.env.OPHIS_MEGAETH_DEPLOYER_PK ?? "";
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
// canonical CREATE2 address on every chain. For Ophis, that hands control of
// our deploy to CoW's key-holder — they could addSolver/setManager on a
// contract we deployed. We override both to the Ophis deployer EOA (or HW
// wallet, for mainnets) so we own the allowlist on every Ophis-target chain.
// Side-effect: our proxy + Settlement land at NEW addresses, distinct from
// the canonical CoW addresses on every other chain. That is the desired
// behaviour for Ophis.
//
// Testnet networks read the deployer address from env (Keychain-sourced
// software key). Mainnet networks hardcode OPHIS_HW_WALLET — the Ledger
// signs at deploy time, no env-var indirection.
const OPHIS_TESTNET_DEPLOYER_ADDRESS = process.env.OPHIS_MEGAETH_DEPLOYER_ADDRESS ?? "";

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
      // Ledger-signed. Connect device + open Ethereum app before running deploy.
      ledgerAccounts: [OPHIS_HW_WALLET],
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
      // Ledger-signed. Connect device + open Ethereum app before running deploy.
      ledgerAccounts: [OPHIS_HW_WALLET],
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
    "linea-sepolia": {
      url: process.env.LINEA_SEPOLIA_RPC ?? "https://rpc.sepolia.linea.build",
      chainId: 59141,
      accounts,
    },
    "linea-mainnet": {
      url: process.env.LINEA_MAINNET_RPC ?? "https://rpc.linea.build",
      chainId: 59144,
      accounts,
    },
  },
  namedAccounts: {
    ...((baseConfig as { namedAccounts?: Record<string, unknown> })
      .namedAccounts ?? {}),
    owner: {
      ...(((baseConfig as { namedAccounts?: { owner?: unknown } })
        .namedAccounts?.owner ?? {}) as Record<string, unknown>),
      "megaeth-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "megaeth-mainnet": OPHIS_HW_WALLET,
      "hyperevm-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "hyperevm-mainnet": OPHIS_HW_WALLET,
      "optimism-sepolia": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "optimism-mainnet": OPHIS_HW_WALLET,
      "katana-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "katana-mainnet": OPHIS_HW_WALLET,
      "mantle-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "mantle-mainnet": OPHIS_HW_WALLET,
      "linea-sepolia": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "linea-mainnet": OPHIS_HW_WALLET,
    },
    manager: {
      ...(((baseConfig as { namedAccounts?: { manager?: unknown } })
        .namedAccounts?.manager ?? {}) as Record<string, unknown>),
      "megaeth-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "megaeth-mainnet": OPHIS_HW_WALLET,
      "hyperevm-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "hyperevm-mainnet": OPHIS_HW_WALLET,
      "optimism-sepolia": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "optimism-mainnet": OPHIS_HW_WALLET,
      "katana-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "katana-mainnet": OPHIS_HW_WALLET,
      "mantle-testnet": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "mantle-mainnet": OPHIS_HW_WALLET,
      "linea-sepolia": OPHIS_TESTNET_DEPLOYER_ADDRESS,
      "linea-mainnet": OPHIS_HW_WALLET,
    },
  },
};

export default config;
