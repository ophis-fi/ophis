/**
 * Immutable appData documents from the retired first Unichain orderbook.
 *
 * The orderbook VM was rebuilt without its old Postgres volume, but these five
 * orders remain immutable on-chain and are part of the public reporting ledger.
 * Two documents survived in the Optimism content store. The other three were
 * reconstructed byte-for-byte from the historical deterministic frontend shape;
 * for permit orders, the signed permit bytes and gas limit were recovered from
 * the settlement transaction's HooksTrampoline calldata. Every lookup is
 * re-hashed below, so a transcription or later edit fails closed.
 */
import { keccak256, stringToHex } from 'viem';

const OPHIS_SAFE = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8';
const UNICHAIN_USDC = '0x078d782b760474a361dda0af3839290b0ef57ad6';
const PERMIT_DAPP_ID = 'cow-swap://libs/hook-dapp-lib/permit';

function plainMarketAppData(slippageBips: number): string {
  return JSON.stringify({
    appCode: 'ophis',
    metadata: {
      orderClass: { orderClass: 'market' },
      partnerFee: { recipient: OPHIS_SAFE, volumeBps: 10 },
      quote: { slippageBips, smartSlippage: true },
    },
    version: '1.14.0',
  });
}

function permitMarketAppData(
  callData: `0x${string}`,
  gasLimit: string,
  slippageBips: number,
): string {
  return JSON.stringify({
    appCode: 'ophis',
    metadata: {
      hooks: {
        pre: [
          {
            callData,
            dappId: PERMIT_DAPP_ID,
            gasLimit,
            target: UNICHAIN_USDC,
          },
        ],
      },
      orderClass: { orderClass: 'market' },
      partnerFee: { recipient: OPHIS_SAFE, volumeBps: 10 },
      quote: { slippageBips, smartSlippage: true },
    },
    version: '1.14.0',
  });
}

const LEGACY_APP_DATA: Readonly<Record<`0x${string}`, string>> = Object.freeze({
  // Retained by the Optimism sovereign content store.
  '0xcf377e8e104f5a12a0b11771e467c497c62f6788c3c7b4167a61896f186e6357': plainMarketAppData(51),
  // Permit recovered from Unichain settlement tx 0x97e528e2…b24a22d.
  '0x59791ede6cd961a808541931e6b05c8a3739d707fd22b8046f8e43a0de0672c3': permitMarketAppData(
    '0xd505accf0000000000000000000000000494f503912c101bfd76b88e4f5d8a33de284d1a000000000000000000000000ab29e2a859704c914e55566ae9b3a7ede25959cb000000000000000000000000000000000000000000000000000000000017d0160000000000000000000000000000000000000000000000000000000073ab0e90000000000000000000000000000000000000000000000000000000000000001c375d6302faf6dfe972a954f1f55029f1211e25b5ee108cc46688c1de05cced006e7615b003fcc29ace2bfe6c7c0d7dee2cef04d7f21aac49e061eabda112f614',
    '91879',
    56,
  ),
  // Permit recovered from Unichain settlement tx 0xa78930a0…6d34e920.
  '0x5d2026c9ec667c94ef9dc9de6362201dfb3ec5296f2c10067d6a540b70737f8b': permitMarketAppData(
    '0xd505accf0000000000000000000000000494f503912c101bfd76b88e4f5d8a33de284d1a000000000000000000000000ab29e2a859704c914e55566ae9b3a7ede25959cb000000000000000000000000000000000000000000000000000000000036d9af0000000000000000000000000000000000000000000000000000000073c1a791000000000000000000000000000000000000000000000000000000000000001cdcaa8ed8e17186ec37625626001ca47dec2993bbce6c6ed1810f1beabc17cc5e4cec82f900019e806f3cef811e072559de10c34c33ca95df3d0527266ce86090',
    '80000',
    53,
  ),
  // Retained by the Optimism sovereign content store.
  '0xa0e9a38f70a8146ba526d84e4d84afbf129ea50ba15fe77c7d86725bb28d4351': plainMarketAppData(50),
  // Reconstructed from the deterministic frontend document shape.
  '0x913f246c50916c50f49d521400ed2ee17d40a4031ff133dc041f9c19b2645e03': plainMarketAppData(55),
});

export function resolveLegacyAppData(hash: `0x${string}`): string | null {
  const normalized = hash.toLowerCase() as `0x${string}`;
  const fullAppData = LEGACY_APP_DATA[normalized];
  if (fullAppData === undefined) return null;
  if (keccak256(stringToHex(fullAppData)) !== normalized) {
    throw new Error(`legacy appData registry hash mismatch for ${normalized}`);
  }
  return fullAppData;
}
