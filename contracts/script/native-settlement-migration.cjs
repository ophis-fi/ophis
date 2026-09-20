// Generates unsigned CREATE2 transactions only. Run after:
// FOUNDRY_PROFILE=direct-routes forge build
/* eslint-disable @typescript-eslint/no-var-requires -- Run without a TypeScript loader. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { utils } = require("ethers");

const root = path.resolve(__dirname, "..");
const proxy = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const robinhood = [
  "0x886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD",
  "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
];
const routes = [
  {
    chainId: 10,
    name: "optimism-uniswap-v4",
    contract: "OphisHooklessUniswapV4Adapter",
    previousAddress: "0xd882da9CB91EB458337413E5846824CDCADB2Ddc",
    expectedAddress: "0x833fA253e3A0cb2be15F14Cb0B0Ad0C17dD57b12",
    saltLabel: "ophis.optimism.hookless-v4.v2",
    args: [
      "0x310784c7FCE12d578dA6f53460777bAc9718B859",
      "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3",
      "0x4200000000000000000000000000000000000006",
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      500,
      10,
    ],
  },
  {
    chainId: 130,
    name: "unichain-uniswap-v4",
    contract: "OphisHooklessUniswapV4Adapter",
    previousAddress: "0x4C41eC6850300d2D6Ba65d602fd31eC07F255b2C",
    expectedAddress: "0xe490d7aC34CDf92a3Bd16cd4cA3BB1F1a6671828",
    saltLabel: "ophis.unichain.hookless-v4.v2",
    args: [
      "0x108A678716e5E1776036eF044CAB7064226F714E",
      "0x1F98400000000000000000000000000000000004",
      "0x4200000000000000000000000000000000000006",
      "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
      500,
      10,
    ],
  },
  {
    chainId: 4663,
    name: "robinhood-uniswap-v4",
    contract: "OphisUniswapV4Adapter",
    previousAddress: "0x8573C5Fcf5BD890f4EDD4a41e783Eac552B307ae",
    expectedAddress: "0xb0F223B932B6C2a5CB6e3a6B04AAB82b44eA7C29",
    saltLabel: "ophis.robinhood.hookless-v4.v2",
    args: robinhood,
  },
  {
    chainId: 4663,
    name: "robinhood-fables",
    contract: "OphisFablesAdapter",
    previousAddress: "0xa0C33928831cB4518b8c4A7BE6c0f98BA8A22de5",
    expectedAddress: "0xC35FE0dBABd82f9E347CF6a7d9c795A18c902FbE",
    saltLabel: "ophis.robinhood.fables.v2",
    args: robinhood,
  },
];

const transactions = routes.map(({ args, ...route }) => {
  const artifact = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "out/direct-routes",
        `${route.contract}.sol`,
        `${route.contract}.json`,
      ),
    ),
  );
  const metadata = JSON.parse(artifact.rawMetadata);
  assert.equal(metadata.compiler.version, "0.8.30+commit.73712a01");
  assert.deepEqual(metadata.settings.optimizer, {
    enabled: true,
    runs: 1000000,
  });
  assert.equal(metadata.settings.evmVersion, "cancun");
  assert.equal(metadata.settings.viaIR ?? false, false);
  assert.deepEqual(metadata.settings.remappings, [
    ":forge-std/=lib/forge-std/src/",
  ]);
  for (const [source, { keccak256 }] of Object.entries(metadata.sources)) {
    assert.equal(
      utils.keccak256(fs.readFileSync(path.join(root, source))),
      keccak256,
      `stale artifact: ${source}`,
    );
  }
  const constructor = artifact.abi.find(({ type }) => type === "constructor");
  const constructorArguments = utils.defaultAbiCoder.encode(
    constructor.inputs.map(({ type }) => type),
    args,
  );
  const initcode = utils.hexConcat([
    artifact.bytecode.object,
    constructorArguments,
  ]);
  const salt = utils.id(route.saltLabel);
  const initcodeHash = utils.keccak256(initcode);
  assert.equal(
    utils.getCreate2Address(proxy, salt, initcodeHash),
    route.expectedAddress,
    `unreviewed build: ${route.name}`,
  );
  return {
    ...route,
    constructorArguments: args,
    salt,
    initcodeHash,
    transaction: {
      chainId: utils.hexValue(route.chainId),
      to: proxy,
      value: "0x0",
      data: utils.hexConcat([salt, initcode]),
    },
  };
});
process.stdout.write(`${JSON.stringify(transactions, null, 2)}\n`);
