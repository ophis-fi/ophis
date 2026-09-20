/* eslint-disable @typescript-eslint/no-var-requires -- Run without a TypeScript loader. */
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const { test } = require("node:test");

const { ethers } = require("ethers");

test("security overrides preserve signing and the legacy tooling APIs", async () => {
  const signing = createRequire(require.resolve("@ethersproject/signing-key"));
  const curve = new (signing("elliptic").ec)("secp256k1");
  // GHSA-vjh7-7g9h-fjfh: negative messages reused the nonce and exposed keys.
  assert.throws(() => curve.sign(`-${"01".repeat(32)}`, Buffer.alloc(32, 1)));
  const wallet = new ethers.Wallet(`0x${"01".repeat(32)}`);
  const message = "Ophis dependency compatibility";
  assert.equal(
    ethers.utils.verifyMessage(message, await wallet.signMessage(message)),
    wallet.address,
  );
  assert.deepEqual(
    [ethers.BigNumber.from(3)],
    [signing("@ethersproject/bignumber").BigNumber.from(3)],
  );

  const rpc = require("ganache").provider({ logging: { quiet: true } });
  try {
    const provider = new ethers.providers.Web3Provider(rpc);
    const tx = await provider.getSigner().sendTransaction({
      to: wallet.address,
      value: 1,
    });
    assert.equal((await tx.wait()).status, 1);
    assert.equal((await provider.getBalance(wallet.address)).toString(), "1");
  } finally {
    await rpc.disconnect();
  }

  const resolver = createRequire(require.resolve("@resolver-engine/core"));
  const jar = resolver("request").jar();
  jar.setCookie("session=ok; Path=/", "https://example.com");
  assert.equal(jar.getCookieString("https://example.com"), "session=ok");

  const server = createServer((_, response) =>
    response.end("pragma solidity ^0.8.0;"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const parse = require("@resolver-engine/core").parsers.UrlParser();
    assert.equal(
      await parse(`http://127.0.0.1:${server.address().port}/Contract.sol`),
      "pragma solidity ^0.8.0;",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  for (const consumer of ["hardhat", "@ledgerhq/client-ids/store"]) {
    const { v4, validate } = createRequire(require.resolve(consumer))("uuid");
    assert.ok(validate(v4()));
  }
});
