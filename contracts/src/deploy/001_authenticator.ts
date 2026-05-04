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
  // Greg patch: chain-aware gas limit. MegaETH consumes ~45× more gas per
  // opcode than standard EVM, so we ship a high default for it; HyperEVM
  // (and other normal chains) cap at 30M per big block, so we use a much
  // lower value there. Read GREG_AUTH_PROXY_GAS_LIMIT to override.
  const overrideGas = process.env.GREG_AUTH_PROXY_GAS_LIMIT;
  const gasLimit = overrideGas
    ? Number(overrideGas)
    : (process.env.HARDHAT_NETWORK ?? "").startsWith("megaeth")
      ? 100000000
      : 25000000;
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
