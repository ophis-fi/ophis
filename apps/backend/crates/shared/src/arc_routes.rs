//! Arc-only direct routing grammars. These are not general router allowlists.
use alloy::{
    primitives::{Address, Bytes, U256, address},
    sol,
    sol_types::{SolCall, SolValue},
};

// First-party Arc deployment records, checked 2026-09-26:
// https://app.aero.xyz/assets/index-DyVaaWzS.js (Arc configuration + supported pools)
// https://developers.uniswap.org/docs/protocols/v4/deployments#arc-5042
pub const AERO_ROUTER: Address = address!("7275fA44c67bba8D921422e600b4Ed396209C886");
pub const AERO_QUOTER: Address = address!("61d0Aa4a814a68F3119019f9f17ACa517FEa6D49");
pub const V4_ROUTER: Address = address!("8702463e73f74d0b6765aBceb314Ef07aCb92650");
pub const V4_QUOTER: Address = address!("8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94");
pub const USDC: Address = address!("3600000000000000000000000000000000000000");
pub const EURC: Address = address!("bEf5f6d51CB62b58e6A8f77868681825C6fe21c1");
// Pool membership and currencies corroborated against Aero's factory at
// 0x2239c18f7955f832b4ec1b5c1b50804b943704efbbaa28f9ffeb27b3fed6b786.
// ponytail: pinned direct pools; add newly verified pools here, aggregators cover the rest.
pub const AERO_POOLS: &[(Address, Address, Address)] = &[
    (
        address!("be080aC37ad1305DFCc9521F5e6F68CFDc41B7fa"),
        USDC,
        EURC,
    ),
    (
        address!("5e9331bf2731887556F7064CEBCA00BA6d0b02AE"),
        USDC,
        address!("bBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b"),
    ),
    (
        address!("d945cAEe4635BcD7FB8A9fA74dC1D0c4C1472782"),
        address!("171A4217b86A807A64eB94757Db6849fb4bDbAA0"),
        USDC,
    ),
    (
        address!("72DfF32c9C5c28758565bE0a7d4E6E42FB498506"),
        address!("128cC466B61f542da60c70e3aA11c10e19B84EDB"),
        address!("171A4217b86A807A64eB94757Db6849fb4bDbAA0"),
    ),
    (
        address!("6F302dECb49fB30B2D2c609BDD16e04e7Dd096FC"),
        address!("128cC466B61f542da60c70e3aA11c10e19B84EDB"),
        USDC,
    ),
];
pub const V4_TIERS: &[(u32, i32)] = &[(100, 1), (500, 10), (3000, 60), (10000, 200)];

sol! {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct QuoteParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    struct V4SwapParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData; }
    struct BalanceSpend { uint8 mode; uint256 value; }
    struct AeroSwapParams { address[] pools; address tokenIn; BalanceSpend amountIn; bool payerIsUser; uint256 minAmountOut; address recipient; }
    function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function quoteExactInput(address[] pools, address tokenIn, uint256 amountIn) external returns (uint256 amountOut, uint160[] prices, uint32[] ticks);
    function quoteExactInputSingle(QuoteParams params) external returns (uint256 amountOut, uint256 gasEstimate);
}

pub fn valid_pair(sell: Address, buy: Address) -> bool {
    !sell.is_zero()
        && !buy.is_zero()
        && sell != buy
        && sell != address!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
        && buy != address!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")
}

pub fn aero_pool(sell: Address, buy: Address) -> Option<Address> {
    AERO_POOLS
        .iter()
        .find(|(_, a, b)| (*a == sell && *b == buy) || (*b == sell && *a == buy))
        .map(|(pool, _, _)| *pool)
}

pub fn aero_calldata(
    sell: Address,
    buy: Address,
    input: U256,
    minimum: U256,
    recipient: Address,
) -> Option<Vec<u8>> {
    let pool = aero_pool(sell, buy)?;
    if input.is_zero() || minimum.is_zero() || recipient.is_zero() {
        return None;
    }
    let params = AeroSwapParams {
        pools: vec![pool],
        tokenIn: sell,
        amountIn: BalanceSpend {
            mode: 0,
            value: input,
        },
        payerIsUser: true,
        minAmountOut: minimum,
        recipient,
    };
    Some(
        executeCall {
            commands: vec![0x00].into(),
            inputs: vec![params.abi_encode().into()],
            deadline: U256::MAX,
        }
        .abi_encode(),
    )
}

pub fn v4_key(sell: Address, buy: Address, tier: (u32, i32)) -> Option<PoolKey> {
    if !valid_pair(sell, buy) || !V4_TIERS.contains(&tier) {
        return None;
    }
    Some(PoolKey {
        currency0: sell.min(buy),
        currency1: sell.max(buy),
        fee: tier.0.try_into().ok()?,
        tickSpacing: tier.1.try_into().ok()?,
        hooks: Address::ZERO,
    })
}

pub fn v4_calldata(
    sell: Address,
    buy: Address,
    tier: (u32, i32),
    input: U256,
    minimum: U256,
) -> Option<Vec<u8>> {
    if input.is_zero() || minimum.is_zero() {
        return None;
    }
    let params = V4SwapParams {
        poolKey: v4_key(sell, buy, tier)?,
        zeroForOne: sell < buy,
        amountIn: input.try_into().ok()?,
        amountOutMinimum: minimum.try_into().ok()?,
        minHopPriceX36: U256::ZERO,
        hookData: Bytes::new(),
    };
    // Exact input must settle in full (partial fills revert), from the router's
    // atomically prefunded ERC20 balance. TAKE_ALL pays the calling Settlement.
    let actions = (
        Bytes::from(vec![0x06, 0x0b, 0x0f]),
        vec![
            Bytes::from(params.abi_encode()),
            Bytes::from((sell, input, false).abi_encode()),
            Bytes::from((buy, minimum).abi_encode()),
        ],
    )
        .abi_encode_params();
    Some(
        executeCall {
            commands: vec![0x10].into(),
            inputs: vec![actions.into()],
            deadline: U256::MAX,
        }
        .abi_encode(),
    )
}

pub fn v4_funding(input: U256) -> Vec<u8> {
    transferCall {
        to: V4_ROUTER,
        amount: input,
    }
    .abi_encode()
}

/// Compare against each supported pool tier's complete canonical encoding.
/// This rejects altered commands, hooks, payers, recipients,
/// amount sentinels, alternate offsets, trailing bytes and allow-revert flags.
pub fn valid_v4_calldata(
    data: &[u8],
    sell: Address,
    buy: Address,
    input: U256,
    minimum: U256,
) -> bool {
    V4_TIERS.iter().any(|&tier| {
        v4_calldata(sell, buy, tier, input, minimum).is_some_and(|expected| expected == data)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arc_router_grammars_are_bounded_and_canonical() {
        for (sell, buy) in [(USDC, EURC), (EURC, USDC)] {
            let input = U256::from(1_000_000);
            let minimum = U256::from(800_000);
            let encoded = v4_calldata(sell, buy, (100, 1), input, minimum).unwrap();
            // Independent ethers ABI fixtures (same grammar exercised by the
            // read-only mainnet settlement probe), including dynamic offsets.
            if sell == USDC {
                assert_eq!(
                    alloy::primitives::keccak256(&encoded),
                    alloy::primitives::b256!(
                        "6c8bddc9626d02ebbb0fa87c2f598f43b52bc5134bcf70ce7a8c68d349b56934"
                    )
                );
                let aero =
                    aero_calldata(sell, buy, input, minimum, Address::repeat_byte(1)).unwrap();
                assert_eq!(
                    alloy::primitives::keccak256(aero),
                    alloy::primitives::b256!(
                        "7fbe4cbf8e6a6e7e6149f7201e560ff346e7b0ed95819791f8a7a7fb1a98d318"
                    )
                );
            }
            assert!(valid_v4_calldata(&encoded, sell, buy, input, minimum));
            for i in 0..encoded.len() {
                let mut mutated = encoded.clone();
                mutated[i] ^= 1;
                assert!(
                    !valid_v4_calldata(&mutated, sell, buy, input, minimum),
                    "accepted mutation at {i}"
                );
            }
            assert!(!valid_v4_calldata(
                &[encoded.as_slice(), &[0]].concat(),
                sell,
                buy,
                input,
                minimum
            ));
            let aero = aero_calldata(sell, buy, input, minimum, Address::repeat_byte(1)).unwrap();
            let call = executeCall::abi_decode(&aero).unwrap();
            assert_eq!(call.commands.as_ref(), &[0x00]);
            let params = AeroSwapParams::abi_decode(&call.inputs[0]).unwrap();
            assert!(params.payerIsUser);
            assert_eq!(params.pools, [aero_pool(sell, buy).unwrap()]);
        }
        assert!(v4_calldata(USDC, EURC, (500, 1), U256::from(1), U256::from(1)).is_none());
        assert!(v4_calldata(USDC, EURC, (100, 1), U256::MAX, U256::from(1)).is_none());
        assert!(v4_key(Address::ZERO, EURC, (100, 1)).is_none());
        assert!(aero_pool(USDC, Address::repeat_byte(9)).is_none());
    }
}
