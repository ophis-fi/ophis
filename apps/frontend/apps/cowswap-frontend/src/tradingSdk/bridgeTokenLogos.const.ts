// Verified identities from https://1click.chaindefuser.com/v0/tokens (2026-10-01).
// Native and wrapped-native assets use the shared chain metadata instead.
// Pin artwork to chain/address, including provider aliases ($WIF, xBTC, wNEAR, USDT0, nrUsdt).
// An arbitrary token symbol must never select canonical artwork.
export const BRIDGE_TOKEN_LOGOS: Readonly<Record<string, string>> = {
  // eth
  '1:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': '/logos/token-uni.png',
  '1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': '/logos/token-wbtc.png',
  '1:0x514910771af9ca656af840dff83e8264ecf986ca': '/logos/token-link.png',
  '1:0x68749665ff8d2d112fa859aa293f07a622782f38': '/logos/token-xaut.png',
  '1:0x6982508145454ce325ddbe47a25d4ec3d2311933': '/logos/token-pepe.png',
  '1:0x6b175474e89094c44da98b954eedeac495271d0f': '/logos/token-dai.png',
  '1:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': '/logos/token-aave.png',
  '1:0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce': '/logos/token-shib.png',
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': '/logos/token-usdc.png',
  '1:0xa35923162c49cf95e6bf26623385eb431ad920d3': '/logos/token-turbo.png',
  '1:0xaaee1a9723aadb7afa2810263653a34ba2c21c7a': '/logos/token-mog.png',
  '1:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': '/logos/token-cbbtc.png',
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': '/logos/token-usdt.png',
  '1:0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202': '/logos/token-knc.jpg',
  '1:0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c': '/logos/token-spx.png',
  // base
  '8453:0x532f27101965dd16442e59d40670faf5ebb142e4': '/logos/token-brett.png',
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': '/logos/token-usdc.png',
  '8453:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': '/logos/token-cbbtc.png',
  // arb
  '42161:0x912ce59144191c1204e64559fe8253a0e49e6548': '/logos/token-arb.jpg',
  '42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831': '/logos/token-usdc.png',
  '42161:0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a': '/logos/token-gmx.png',
  '42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': '/logos/token-usdt.png',
  // op
  '10:0x01bff41798a0bcf287b996046ca68b395dbc1071': '/logos/token-usdt.png',
  '10:0x0b2c639c533813f4aa9d7837caf62653d097ff85': '/logos/token-usdc.png',
  '10:0x4200000000000000000000000000000000000042': '/logos/token-op.png',
  '10:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': '/logos/token-usdt.png',
  // gnosis
  '100:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0': '/logos/token-usdc.png',
  '100:0x4ecaba5870353805a9f068101a40e0f32ed605c6': '/logos/token-usdt.png',
  '100:0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1': '/logos/token-weth.png',
  '100:0x9c58bacc331c9aa871afd802db6379a98e80cedb': '/logos/token-gno.png',
  // pol
  '137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': '/logos/token-usdc.png',
  '137:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': '/logos/token-weth.png',
  '137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': '/logos/token-usdt.png',
  // bsc
  '56:0x1fa4a73a3f0133f0025378af00236f3abdee5d63': '/logos/token-near.svg',
  '56:0x5382555840ef9f54ef6d3ee5da60f12bcabf4b87': '/logos/token-usdt.png',
  '56:0x55d398326f99059ff775485246999027b3197955': '/logos/token-usdt.png',
  '56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': '/logos/token-usdc.png',
  // avax
  '43114:0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': '/logos/token-usdt.png',
  '43114:0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': '/logos/token-usdc.png',
  // monad
  '143:0x754704bc059f8c67012fed69bc8a327a5aafb603': '/logos/token-usdc.png',
  '143:0xe7cd86e13ac4309349f30b3435a9d337750fc82d': '/logos/token-usdt.png',
  // xlayer
  '196:0x74b7f16337b8972027f6196a17a631ac6de26d22': '/logos/token-usdc.png',
  '196:0x779ded0c9e1022225f8e0630b35a9b54be713736': '/logos/token-usdt.png',
  // sui
  '1000000101:0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC': '/logos/token-usdc.png',
  // tron
  '1000000102:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t': '/logos/token-usdt.png',
  // hypercore
  '1000000103:0x20b8c9d2f022ffd2aea4f7962b7b1d8b': '/logos/token-near.svg',
  '1000000103:0x6d1e7cde53ba9467b783cb7c530ce054': '/logos/token-usdc.png',
  '1000000103:0xb88339CB7199b77E23DB6E890353E22632Ba630f': '/logos/token-usdc.png',
  // starknet
  '1000000104:0x05ce53b9b68fb8e9ecab9283a96d97948914733fd6ed8d9a53a276a419497841': '/logos/token-zec.svg',
  '1000000104:0x07bc19585817a78f2304b2f3b31f954d80e8a1eff6e8d81a84eb5cedb7267728': '/logos/token-xrp.svg',
  // sol
  '1000000001:2Dyzu65QA9zdX1UeE7Gx71k7fiwyUK6sZdrvJ7auq5wm': '/logos/token-turbo.png',
  '1000000001:3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG': '/logos/token-near.svg',
  '1000000001:6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN': '/logos/token-trump.png',
  '1000000001:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS': '/logos/token-zec.svg',
  '1000000001:CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn': '/logos/token-btc.svg',
  '1000000001:EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': '/logos/token-wif.svg',
  '1000000001:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': '/logos/token-usdc.png',
  '1000000001:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': '/logos/token-usdt.png',
  '1000000001:HsRpHQn6VbyMs5b5j5SV6xQ2VvpvvCCzu19GjytVSCoz': '/logos/token-strk.png',
  '1000000001:J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr': '/logos/token-spx.png',
  // plasma
  '9745:0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': '/logos/token-usdt.png',
  // hood
  '4663:0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34': '/logos/token-usde.png',
  '4663:0x5fc5360d0400a0fd4f2af552add042d716f1d168': '/logos/token-usdg.svg',
  // CoinGecko artwork for these exact catalogue identities; no runtime symbol lookup.
  '1000000001:2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv':
    'https://coin-images.coingecko.com/coins/images/52622/large/PUDGY_PENGUINS_PENGU_PFP.png?1733809110',
  '1000000001:3tMdx4g4grCgqHjELqALfTPnZnG1BLwsPntD3tGREgvp':
    'https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602',
  '1000000001:415bGhU9GtBPPnbtz9csVfcEvFSkVMWJKxQQYAggCUBQ':
    'https://coin-images.coingecko.com/coins/images/102176913/large/nearkat.jpg?1789019515',
  '1000000001:6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr':
    'https://coin-images.coingecko.com/coins/images/102176913/large/nearkat.jpg?1789019515',
  '1000000001:8SMMso8Muv8d6i4WmMDthKt6TN1ysN6937sx3DKLXZqB':
    'https://coin-images.coingecko.com/coins/images/67682/large/RHEA_Logo.png?1753517263',
  '1000000001:AXCp86262ZPfpcV9bmtmtnzmJSL5sD99mCVJD4GR9vS':
    'https://coin-images.coingecko.com/coins/images/67977/large/publicai.jpg?1754478612',
  '1000000001:EJZJpNa4tDZ3kYdcRZgaAtaKm3fLJ5akmyPkCaKmfWvd':
    'https://coin-images.coingecko.com/coins/images/66211/large/loud-logo.jpg?1748759689',
  '1000000001:FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P':
    'https://coin-images.coingecko.com/coins/images/53775/large/melania-meme.png?1737329885',
  '1000000001:USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB':
    'https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002',
  '1000000001:ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82':
    'https://coin-images.coingecko.com/coins/images/36071/large/bome.png?1710407255',
  '100:0x177127622c4a00f3d409b75571e12cb3c8973d3c':
    'https://coin-images.coingecko.com/coins/images/24384/large/CoW-token_logo.png?1719524382',
  '100:0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430':
    'https://coin-images.coingecko.com/coins/images/54303/large/eure.jpg?1739167959',
  '100:0x4d18815d14fe5c3304e87b3fa18318baa5c23820':
    'https://coin-images.coingecko.com/coins/images/27032/large/Artboard_1_copy_8circle-1.png?1696526084',
  '100:0x5cb9073902f2035222b9749f8fb0c9bfe5527108':
    'https://coin-images.coingecko.com/coins/images/39004/large/gbp.png?1719840784',
  '137:0x7b12598e3616261df1c05ec28de0d2fb10c1f206':
    'https://coin-images.coingecko.com/coins/images/52379/large/_COCA_Token_1.png?1733257913',
  '1:0x06ea695b91700071b161a434fed42d1dcbad9f00':
    'https://coin-images.coingecko.com/coins/images/67027/large/hemibtc.jpg?1751514905',
  '1:0x5afe3855358e112b5647b952709e6165e1c1eeee':
    'https://coin-images.coingecko.com/coins/images/27032/large/Artboard_1_copy_8circle-1.png?1696526084',
  '1:0x8b1484d57abbe239bb280661377363b03c89caea':
    'https://coin-images.coingecko.com/coins/images/68846/large/ADI_Token-min.png?1765296433',
  '1:0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d':
    'https://coin-images.coingecko.com/coins/images/54977/large/USD1_1000x1000_transparent.png?1749297002',
  '1:0xaaaaaa20d9e0e2461697782ef11675f668207961':
    'https://coin-images.coingecko.com/coins/images/20582/large/aurora.jpeg?1696519989',
  '1:0xb4b9dc1c77bdbb135ea907fd5a08094d98883a35':
    'https://coin-images.coingecko.com/coins/images/25057/large/Sweat_-_logo-nov-2025.png?1762411781',
  '1:0xd9c2d319cd7e6177336b0a9c93c21cb48d84fb54':
    'https://coin-images.coingecko.com/coins/images/14298/large/Hapi_logo_square_%281%29.png?1696513995',
  '1:0xdef1b2d939edc0e4d35806c59b3166f790175afe':
    'https://coin-images.coingecko.com/coins/images/70868/large/infinex.png?1764322875',
  '1:0xfa2b947eec368f42195f24f36d2af29f7c24cec2':
    'https://coin-images.coingecko.com/coins/images/54558/large/ff_200_X_200.png?1740741076',
  '42161:0xca7dec8550f43a5e46e3dfb95801f64280e75b27':
    'https://coin-images.coingecko.com/coins/images/25057/large/Sweat_-_logo-nov-2025.png?1762411781',
  '4663:0x020bfc650a365f8bb26819deaabf3e21291018b4':
    'https://coin-images.coingecko.com/coins/images/102174280/large/cashcat-logo.jpg?1782922765',
  '4663:0x39dbed3a2bd333467115de45665cc57f813c4571':
    'https://coin-images.coingecko.com/coins/images/102174571/large/jhitvkisdq8fhxvimdkpcw7y3dx5.?1784093932',
  '56:0x000ae314e2a2172a039b26378814c252734f556a':
    'https://coin-images.coingecko.com/coins/images/69040/large/_ASTER.png?1757326782',
  '56:0x1a6659d434482a2b1694098c6757a62a8619cf12':
    'https://coin-images.coingecko.com/coins/images/20582/large/aurora.jpeg?1696519989',
  '56:0x4c067de26475e1cefee8b8d1f6e2266b33a2372e':
    'https://coin-images.coingecko.com/coins/images/67682/large/RHEA_Logo.png?1753517263',
  '56:0x510ad22d8c956dcc20f68932861f54a591001283':
    'https://coin-images.coingecko.com/coins/images/25057/large/Sweat_-_logo-nov-2025.png?1762411781',
  '56:0xaa036928c9c0df07d525b55ea8ee690bb5a628c1':
    'https://coin-images.coingecko.com/coins/images/69601/large/evaa.png?1759214696',
  '8453:0x0382e3fee4a420bd446367d468a6f00225853420':
    'https://coin-images.coingecko.com/coins/images/70993/large/o6dyoqfbdes0qabkk4p6ed9ighgz.?1765019681',
  '8453:0x1c4a802fd6b591bb71daa01d8335e43719048b24':
    'https://coin-images.coingecko.com/coins/images/6319/large/USDC.png?1769615602',
  '8453:0x227d920e20ebac8a40e7d6431b7d724bb64d7245':
    'https://coin-images.coingecko.com/coins/images/25057/large/Sweat_-_logo-nov-2025.png?1762411781',
  '8453:0x959fc04dbf97a27073f89237cd62605f4d1b906d':
    'https://coin-images.coingecko.com/coins/images/52379/large/_COCA_Token_1.png?1733257913',
  '8453:0x98d0baa52b2d063e780de12f615f963fe8537553':
    'https://coin-images.coingecko.com/coins/images/54411/large/Qm4DW488_400x400.jpg?1739552780',
  '8453:0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf':
    'https://coin-images.coingecko.com/coins/images/54023/large/VVV_Token_Transparent.png?1741856877',
  '8453:0xe62bfbe57763ec24c0f130426f34dbce11fc5b06':
    'https://coin-images.coingecko.com/coins/images/70474/large/TITNToken%281%29.png?1764103345',
}
