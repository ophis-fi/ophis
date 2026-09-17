/* eslint-disable @typescript-eslint/no-var-requires -- Run without a TypeScript loader. */
const assert = require("node:assert/strict");
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

  const legacy = createRequire(require.resolve("ganache-core"));
  const prototype = { guard: "present" };
  legacy("lodash").unset(Object.create(prototype), [["__proto__"], "guard"]);
  assert.equal(prototype.guard, "present");

  const rpc = require("ganache-core").provider();
  try {
    const provider = new ethers.providers.Web3Provider(rpc);
    const tx = await provider.getSigner().sendTransaction({
      to: wallet.address,
      value: 1,
    });
    assert.equal((await tx.wait()).status, 1);
    assert.equal((await provider.getBalance(wallet.address)).toString(), "1");
  } finally {
    await new Promise((resolve, reject) =>
      rpc.close((error) => (error ? reject(error) : resolve())),
    );
  }

  const transformed = require("babel-core").transform(
    "const add = x => x + 1",
    {
      babelrc: false,
      presets: [
        [
          require.resolve("babel-preset-env"),
          { targets: { browsers: ["ie 11"] } },
        ],
      ],
    },
  );
  assert.ok(!transformed.code.includes("=>"));
  const jar = legacy("request").jar();
  jar.setCookie("session=ok; Path=/", "https://example.com");
  assert.equal(jar.getCookieString("https://example.com"), "session=ok");
  const fetch = createRequire(require.resolve("fetch-ponyfill"))("node-fetch");
  assert.equal(await new fetch.Response("ok").text(), "ok");
});
