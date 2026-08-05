// Ophis — Hardhat config for sovereign-chain recovery and redeployment.
//
// This deliberately contains only supported Ophis-operated networks. Run from
// contracts/ with HARDHAT_CONFIG=hardhat-ophis.config.ts and the desired
// --network. Mainnet signing is delegated to the configured Ledger account.

import "@nomicfoundation/hardhat-ledger";
import baseConfig from "./hardhat.config";

const OPHIS_HW_WALLET = "0xBeC5B03ffDcac50071693E87bFDb88bAa6710199";

const sovereignNetworks = {
  "optimism-mainnet": {
    url: process.env.OP_MAINNET_RPC ?? "https://mainnet.optimism.io",
    chainId: 10,
    ledgerAccounts: [OPHIS_HW_WALLET],
  },
  "unichain-mainnet": {
    url: process.env.UNICHAIN_MAINNET_RPC ?? "https://mainnet.unichain.org",
    chainId: 130,
    ledgerAccounts: [OPHIS_HW_WALLET],
  },
  "robinhood-mainnet": {
    url:
      process.env.ROBINHOOD_MAINNET_RPC ??
      "https://rpc.mainnet.chain.robinhood.com",
    chainId: 4663,
    ledgerAccounts: [OPHIS_HW_WALLET],
  },
};

const ledgerNamedAccount = {
  "optimism-mainnet": OPHIS_HW_WALLET,
  "unichain-mainnet": OPHIS_HW_WALLET,
  "robinhood-mainnet": OPHIS_HW_WALLET,
};

const config = {
  ...baseConfig,
  networks: {
    ...((baseConfig as { networks?: Record<string, unknown> }).networks ?? {}),
    ...sovereignNetworks,
  },
  namedAccounts: {
    ...((baseConfig as { namedAccounts?: Record<string, unknown> }).namedAccounts ?? {}),
    owner: {
      ...(((baseConfig as { namedAccounts?: { owner?: unknown } }).namedAccounts?.owner ?? {}) as Record<string, unknown>),
      ...ledgerNamedAccount,
    },
    manager: {
      ...(((baseConfig as { namedAccounts?: { manager?: unknown } }).namedAccounts?.manager ?? {}) as Record<string, unknown>),
      ...ledgerNamedAccount,
    },
  },
};

export default config;
