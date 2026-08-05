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
  // Read OPHIS_AUTH_PROXY_GAS_LIMIT to override the safe default.
  const overrideGas = process.env.OPHIS_AUTH_PROXY_GAS_LIMIT;
  const gasLimit = overrideGas ? Number(overrideGas) : 25000000;
  await deploy(authenticator, {
    from: deployer,
    gasLimit,
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
