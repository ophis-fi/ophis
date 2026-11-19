// The golden values of the desk's appData, made by @ophis/sdk itself (never by the console's copy in src/server/orders.ts).
// Run once with tsx, outside the console (the console is no workspace member and does not import the SDK):
//   ../rebate-indexer/node_modules/.bin/tsx scripts/appdata-golden.mjs > tests/fixtures/appdata-golden.json
// tests/worker.test.ts compares the console's appData and stable-pair rule with this file.
import { buildOphisFullAppData } from '../../../packages/sdk/src/order-build.ts'
import { isOphisStablePair } from '../../../packages/sdk/src/stablecoins.ts'
import { getOphisOrderDomain, getOphisVaultRelayer } from '../../../packages/sdk/src/domain.ts'
import { getOphisOrderbookUrl } from '../../../packages/sdk/src/orderbook.ts'

// The tokens of the desk's table (src/server/orders.ts), by chain. Only their addresses are read here. ETH itself is the
// marker address of the settlement (0xEeee...), on every chain but Arc.
const TOKENS = {
  1: ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', '0x39b8B6385416f4cA36a20319F70D28621895279D', '0x5F7827FDeb7c20b443265Fc2F40845B715385Ff2'],
  10: ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x4200000000000000000000000000000000000006', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
  8453: ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x4200000000000000000000000000000000000006', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42'],
  42161: ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '0x0c06cCF38114ddfc35e07427B9424adcca9F44F8'],
  4663: ['0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'],
  5042: ['0x128cC466B61f542da60c70e3aA11c10e19B84EDB', '0x3600000000000000000000000000000000000000', '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1'],
}
const out = { made: 'by @ophis/sdk (packages/sdk/src), scripts/appdata-golden.mjs', chains: {} }
for (const [id, tokens] of Object.entries(TOKENS)) {
  const chainId = Number(id)
  out.chains[id] = {
    orderbook: getOphisOrderbookUrl(chainId), settlement: getOphisOrderDomain(chainId).verifyingContract, relayer: getOphisVaultRelayer(chainId),
    pairs: tokens.flatMap((sell) => tokens.filter((buy) => buy !== sell).map((buy) => ({ sell, buy, stable: isOphisStablePair(chainId, sell, buy) }))),
    appData: [0, 50, 300, undefined].flatMap((slippageBips) => [false, true].map((stable) => {
      const { fullAppData, appDataHash } = buildOphisFullAppData(chainId, slippageBips, undefined, 'business', undefined, stable)
      return { slippageBips: slippageBips ?? null, stable, fullAppData, appDataHash }
    })),
  }
}
console.log(JSON.stringify(out, null, 2))
