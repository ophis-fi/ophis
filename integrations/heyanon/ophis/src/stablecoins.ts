// AUTO-DERIVED from the Ophis frontend STABLECOINS (apps/frontend/libs/common-const/src/tokens.ts),
// the same verified source swap.ophis.fi uses to apply the 1bp stable-pair tier. Lowercased.
// Conservative: a pair not in a chain's set gets the standard rate (never undercharges).
export const OPHIS_STABLECOINS: Record<number, ReadonlySet<string>> = {
  1: new Set(['0x056fd409e1d7a124bd7017459dfea2f387b6d5cd', '0x39b8b6385416f4ca36a20319f70d28621895279d', '0x57ab1ec28d129707052df4df418d58a2d46d5f51', '0x6b175474e89094c44da98b954eedeac495271d0f', '0x6c3ea9036406852006290770bedfcaba0e23a0e8', '0x853d955acef822db058eb8505911ed77f175b99e', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7']),
  10: new Set(['0x0b2c639c533813f4aa9d7837caf62653d097ff85', '0x7f5c764cbc14f9669b88837ca1490cca17c31607', '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1']),
  56: new Set(['0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56']),
  100: new Set(['0x2a22f9c3b484c3629090feed35f17ff8f88f76f0', '0x4ecaba5870353805a9f068101a40e0f32ed605c6', '0x5cb9073902f2035222b9749f8fb0c9bfe5527108', '0xaf204776c7245bf4147c2612bf6e5972ee483701', '0xcb444e90d8198415266c6a2724b7900fb12fc56e', '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83', '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d']),
  130: new Set(['0x078d782b760474a361dda0af3839290b0ef57ad6']),
  137: new Set(['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', '0xe0aea583266584dafbb3f9c3211d5588c73fea8d']),
  8453: new Set(['0x04d5ddf5f3a8939889f11e97f8c4bb48317f1938', '0x4621b7a9c75199271f773ebd9a499dbd165c3191', '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xb79dd08ea68a908a97220c76d19a6aa9cbde4376', '0xbf6e2966a9c3d99c9e4d069e04f7bdb9c8aa762c', '0xca72827a3d211cfd8f6b00ac98824872b72cab49', '0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4', '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2']),
  9745: new Set(['0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb']),
  42161: new Set(['0x0c06ccf38114ddfc35e07427b9424adcca9f44f8', '0x17fc002b466eec40dae837fc4be5c67993ddbd6f', '0x59d9356e565ab3a36dd77763fc0d87feaf85508c', '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34', '0xaf88d065e77c8cc2239327c5edb3a432268e5831', '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0xfea7a6a0b346362bf88a9e4a88416b77a57d6c2a', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8']),
  43114: new Set(['0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e']),
  57073: new Set(['0x0200c29006150606b650577bbe7b6248f58470c1', '0x2d270e6886d130d724215a266106e6832161eaed', '0xf1815bd50389c46847f0bda824ec8da914045d14']),
  59144: new Set(['0x176211869ca2b568f2a7d4ee941e073a821ee1ff', '0x3ff47c5bf409c86533fe1f4907524d304062428d']),
  11155111: new Set(['0x58eb19ef91e8a6327fed391b51ae1887b833cc91', '0xbe72e441bf55620febc26715db68d3494213d8cb']),
};

export function isOphisStablePair(chainId: number, sellToken: string, buyToken: string): boolean {
  const s = OPHIS_STABLECOINS[chainId];
  if (!s) return false;
  return s.has(sellToken.toLowerCase()) && s.has(buyToken.toLowerCase());
}
