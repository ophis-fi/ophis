import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { CONTRACT_NAMES, SALT } from "../ts/deploy";

const deployAuthenticator: DeployFunction = async function ({
  deployments,
  getNamedAccounts,
}: HardhatRuntimeEnvironment) {
  const { deployer, owner, manager } = await getNamedAccounts();
  const { deploy } = deployments;

  const { authenticator } = CONTRACT_NAMES;
  await deploy(authenticator, {
    from: deployer,
    // Greg patch: bumped from 2_000_000 to 100_000_000. MegaETH (chains 6343
    // testnet, 4326 mainnet) consumes ~45× more gas per opcode than typical
    // EVM chains for contract deploys; MegaETH block gas limit is 2_000_000_000
    // ("2 Giga gas") so 100M is well within bounds. On other chains the unused
    // gas is refunded so the bump is harmless. Keep this on subtree pulls.
    gasLimit: 100000000,
    deterministicDeployment: SALT,
    log: true,
    proxy: {
      owner,
      execute: {
        init: {
          methodName: "initializeManager",
          args: [manager],
        },
      },
    },
  });
};

export default deployAuthenticator;
