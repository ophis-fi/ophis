//! Arc Sushi's single V3 pool grammar, pinned to first-party deployments:
//! sushi-labs/sushi@5082d90 (V3 + RedSnwapper configuration) and
//! sushi-labs/sushiswap@bc7c4020 (direct-pool/utils.ts).
use alloy::{
    primitives::{Address, U256, address, b256, keccak256},
    sol,
    sol_types::{SolCall, SolValue},
};

pub const ROUTER: Address = address!("E52abd50ad151ecDf56427effD715E703696a6B1");
pub const PROCESSOR: Address = address!("7906320f8247E36dD9b7B005C8DC740ED4EcC29D");
pub const FACTORY: Address = address!("7282249282902e1f99c2CB0A04230091bd30FE3A");
pub const QUOTER: Address = address!("475d8dAB6dEcbBf89DB860D2673F2472Fa58E5f4");
pub const TIERS: [u32; 4] = [100, 500, 3000, 10000];

sol! {
    function snwap(address tokenIn, uint256 amountIn, address recipient, address tokenOut, uint256 amountOutMin, address executor, bytes executorData) external payable returns (uint256);
    function processRouteWithTransferValueOutput(address transferValueTo, uint256 amountValueTransfer, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOutQuote, address to, bytes route, bool takeSurplus, uint32 referralCode) external payable returns (uint256);
}

pub fn pool(sell: Address, buy: Address, tier: u32) -> Address {
    let salt = keccak256((sell.min(buy), sell.max(buy), U256::from(tier)).abi_encode());
    let mut init = vec![0xff];
    init.extend_from_slice(FACTORY.as_slice());
    init.extend_from_slice(salt.as_slice());
    init.extend_from_slice(
        b256!("e34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54").as_slice(),
    );
    Address::from_slice(&keccak256(init)[12..])
}

pub fn calldata(
    sell: Address,
    buy: Address,
    tier: u32,
    input: U256,
    minimum: U256,
    recipient: Address,
) -> Option<Vec<u8>> {
    if !super::arc_routes::valid_pair(sell, buy)
        || !TIERS.contains(&tier)
        || input.is_zero()
        || minimum.is_zero()
        || recipient.is_zero()
    {
        return None;
    }
    // Version 1, zero expiry, route type 2. Exactly one V3 pool, no wrapping,
    // arbitrary transfers, secondary commands or callbacks from external data.
    let mut route = vec![1, 0, 0, 0, 0, 0, 0, 2, 1];
    route.extend_from_slice(sell.as_slice());
    route.extend_from_slice(&[1, 0xff, 0xff, 1]);
    route.extend_from_slice(pool(sell, buy, tier).as_slice());
    route.push(u8::from(sell < buy));
    route.extend_from_slice(PROCESSOR.as_slice());
    route.extend_from_slice(&[0; 7]);
    let executor_data = processRouteWithTransferValueOutputCall {
        transferValueTo: recipient,
        amountValueTransfer: U256::ZERO,
        tokenIn: sell,
        amountIn: input,
        tokenOut: buy,
        amountOutQuote: minimum,
        to: recipient,
        route: route.into(),
        takeSurplus: false,
        referralCode: 0,
    }
    .abi_encode();
    Some(
        snwapCall {
            tokenIn: sell,
            amountIn: input,
            recipient,
            tokenOut: buy,
            amountOutMin: minimum,
            executor: PROCESSOR,
            executorData: executor_data.into(),
        }
        .abi_encode(),
    )
}

/// Decode the outer amounts, then require the entire nested call to match the
/// pinned grammar. Noncanonical offsets, trailing bytes and extra commands fail.
pub fn decode(
    data: &[u8],
    sell: Address,
    buy: Address,
    recipient: Address,
) -> Option<(U256, U256)> {
    let call = snwapCall::abi_decode(data).ok()?;
    if !TIERS.iter().any(|&tier| {
        calldata(sell, buy, tier, call.amountIn, call.amountOutMin, recipient).as_deref()
            == Some(data)
    }) {
        return None;
    }
    Some((call.amountIn, call.amountOutMin))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_pool_and_nested_execution_are_bound() {
        let canonical = calldata(
            super::super::arc_routes::USDC,
            super::super::arc_routes::EURC,
            10000,
            U256::from(10000),
            U256::from(1),
            Address::repeat_byte(0x11),
        )
        .unwrap();
        // Independently encoded with ethers; eth_simulateV1 at Arc block 23582334
        // returned 8832 EURC units to the recipient with fee=0/takeSurplus=false.
        assert_eq!(
            keccak256(canonical),
            b256!("54f9c32c8acfdeda4dc9c8c62471af1c247d33d1120839ef135844bacd32dfdf")
        );
        let sell = super::super::arc_routes::USDC;
        let buy = super::super::arc_routes::EURC;
        let recipient = Address::repeat_byte(7);
        assert_eq!(
            pool(sell, buy, 10000),
            address!("b50d2ed03f5922863ae072a017d9583d6d9ed764")
        );
        let data = calldata(
            sell,
            buy,
            10000,
            U256::from(10000),
            U256::from(8000),
            recipient,
        )
        .unwrap();
        assert_eq!(
            decode(&data, sell, buy, recipient),
            Some((U256::from(10000), U256::from(8000)))
        );
        // Every byte other than the independently bounded outer input/minimum
        // amounts is fixed by the grammar, including the inner duplicate amounts.
        for index in 0..data.len() {
            let mut bad = data.clone();
            bad[index] ^= 1;
            assert!(decode(&bad, sell, buy, recipient).is_none(), "byte {index}");
        }
        let mut trailing = data.clone();
        trailing.push(0);
        assert!(decode(&trailing, sell, buy, recipient).is_none());
        assert!(decode(&data, buy, sell, recipient).is_none());
        assert!(decode(&data, sell, buy, Address::repeat_byte(8)).is_none());
    }
}
