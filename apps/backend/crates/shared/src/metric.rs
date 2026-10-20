//! Metric v1 single-pool exact-input grammar on Robinhood (4663), shared by the
//! direct solver and the driver guard. No API response supplies a target, pool,
//! token, price or calldata at runtime.
//!
//! Deployments: current `v1` addresses from
//! https://docs.metric.xyz/reference/supported-chains-and-deployments
//! (deterministic CREATE2/CREATE3, identical on every listed chain).
use alloy::{
    primitives::{Address, Bytes, U256, address},
    sol,
    sol_types::SolCall,
};

pub const CHAIN_ID: u64 = 4663;
pub const FACTORY: Address = address!("2a53833cc95548cf52c7b159110e22D3a9018f32");
pub const ROUTER: Address = address!("02201E6f13c41506c7Bb635d7543F98826229aB7");
pub const QUOTER: Address = address!("3B9ea79f482094323d06064E637a7F4528560fcb");
pub const USDG: Address = address!("5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
/// The solver's router deadline, in seconds after it builds the call.
pub const DEADLINE_SECS: u64 = 300;
/// The latest deadline the driver accepts, leaving room for clock skew.
pub const MAX_DEADLINE_SECS: u64 = 600;

/// `(pool, token0, token1)`, generated from the real
/// `GET /public/v1/evm/4663/metadata` response of 2026-10-20 (41 pools). Only
/// the 9 pools Metric classifies `green` are kept: locked, immutable anchored
/// price provider, stop-loss and velocity guard, verified curator, no reason
/// codes. Each was `v1`, unpaused, `healthy` and listed under the pinned
/// factory and quoter. Router `tokenOut` is unchecked onchain, so tokens and
/// direction always come from this table; at its pinned block the solver
/// re-reads `getImmutables()` and the factory's `isPool`.
/// shortcut: nine reviewed pools; verify new pool identities before extending.
pub const POOLS: &[(Address, Address, Address)] = &[
    // WETH/USDG
    (
        address!("1E8Fc442AD3606719F7016DED6C17B56C3cA7386"),
        address!("0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
        USDG,
    ),
    // SPCX/USDG
    (
        address!("A94E5130a57c48B0b2F266709634A45bE7ae8171"),
        address!("4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa"),
        USDG,
    ),
    // META/USDG
    (
        address!("90CABdA18279BBB3D935989aF807b08B0e8CeC61"),
        address!("c0D6457C16Cc70d6790Dd43521C899C87ce02f35"),
        USDG,
    ),
    // NVDA/USDG
    (
        address!("Bc6426CdBCE142dfbff33303dc0923509f61eedc"),
        address!("d0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
        USDG,
    ),
    // TSLA/USDG
    (
        address!("99932C7660dD58cf19f0e82e97F288d88d033480"),
        address!("322F0929c4625eD5bAd873c95208D54E1c003b2d"),
        USDG,
    ),
    // GOOGL/USDG
    (
        address!("2eB3eC0c7e94F83aF3458dE5f907a9910932A6B5"),
        address!("2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3"),
        USDG,
    ),
    // AAPL/USDG
    (
        address!("6a4fc50b14F6D390340bd0BD2fcdB1752852a099"),
        address!("aF3D76f1834A1d425780943C99Ea8A608f8a93f9"),
        USDG,
    ),
    // MU/USDG
    (
        address!("f8b502f67E2Dc185172Dc5a3fE96950e65bf7acA"),
        address!("fF080c8ce2E5feadaCa0Da81314Ae59D232d4afD"),
        USDG,
    ),
    // INTC/USDG
    (
        address!("15C38890Ab7933c6cC06d28184D59b9915A2FC9b"),
        address!("c72b96e0E48ecd4DC75E1e45396e26300BC39681"),
        USDG,
    ),
];

sol! {
    struct ExactInputSingleParams { address pool; address tokenIn; address tokenOut; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; address recipient; uint256 deadline; uint128 priceLimitX64; bytes extensionData; }
    function exactInputSingle(ExactInputSingleParams params) external payable returns (uint256 amountOut);
    function quoteLiveExactInSingle(address pool, address sender, address recipient, bool zeroForOne, uint128 amountIn, uint128 priceLimitX64, bytes extensionData) external returns (uint256 amountIn_, uint256 amountOut);
    // Static return whose first words are (factory, token0, token1).
    function getImmutables() external view;
    function isPool(address pool) external view returns (bool);
}

/// The pinned pool and `zeroForOne` direction for `sell -> buy`.
pub fn route(sell: Address, buy: Address) -> Option<(Address, bool)> {
    POOLS.iter().find_map(|&(pool, token0, token1)| {
        if (sell, buy) == (token0, token1) {
            Some((pool, true))
        } else if (sell, buy) == (token1, token0) {
            Some((pool, false))
        } else {
            None
        }
    })
}

/// The canonical open limit; the amount floor is the only slippage bound.
pub fn price_limit(zero_for_one: bool) -> u128 {
    if zero_for_one { 0 } else { u128::MAX }
}

/// A non-zero input that fits both the router's `uint128` and the quoter's
/// `int128` (`AmountTooLarge` above it).
pub fn exact_input(amount: U256) -> Option<u128> {
    u128::try_from(amount)
        .ok()
        .filter(|&amount| amount != 0 && amount <= i128::MAX as u128)
}

pub fn calldata(
    sell: Address,
    buy: Address,
    input: U256,
    minimum: U256,
    recipient: Address,
    deadline: u64,
) -> Option<Vec<u8>> {
    let (pool, zero_for_one) = route(sell, buy)?;
    let amount_in = exact_input(input)?;
    let minimum = u128::try_from(minimum).ok().filter(|&m| m != 0)?;
    if recipient.is_zero() || deadline == 0 {
        return None;
    }
    Some(
        exactInputSingleCall {
            params: ExactInputSingleParams {
                pool,
                tokenIn: sell,
                tokenOut: buy,
                zeroForOne: zero_for_one,
                amountIn: amount_in,
                amountOutMinimum: minimum,
                recipient,
                deadline: U256::from(deadline),
                priceLimitX64: price_limit(zero_for_one),
                extensionData: Bytes::new(),
            },
        }
        .abi_encode(),
    )
}

/// Returns `(amountIn, amountOutMinimum)` only for the byte-exact canonical
/// call over the pinned pool and direction for `sell -> buy`, paying
/// `recipient`, with a deadline in `(now, now + MAX_DEADLINE_SECS]`. Other
/// selectors, payment helpers, pools, directions, tokens, price limits,
/// extension data, noncanonical offsets and trailing bytes all fail.
pub fn decode(
    data: &[u8],
    sell: Address,
    buy: Address,
    recipient: Address,
    now: u64,
) -> Option<(U256, U256)> {
    let params = exactInputSingleCall::abi_decode(data).ok()?.params;
    let deadline = u64::try_from(params.deadline).ok()?;
    if deadline <= now || deadline > now.checked_add(MAX_DEADLINE_SECS)? {
        return None;
    }
    let input = U256::from(params.amountIn);
    let minimum = U256::from(params.amountOutMinimum);
    (calldata(sell, buy, input, minimum, recipient, deadline)?.as_slice() == data)
        .then_some((input, minimum))
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        alloy::primitives::{b256, keccak256},
    };

    const WETH: Address = address!("0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    const SETTLEMENT: Address = address!("886d9fd312F442C4E1f3cdeAE7b4AB73493e57cD");
    const NOW: u64 = 1_792_050_000 - DEADLINE_SECS;

    #[test]
    fn pinned_pools_are_unique_usdg_pairs() {
        assert_eq!(POOLS.len(), 9);
        for (i, &(pool, token0, token1)) in POOLS.iter().enumerate() {
            assert_eq!(token1, USDG);
            assert!(!pool.is_zero() && !token0.is_zero() && token0 != token1);
            assert_eq!(route(token0, token1), Some((pool, true)));
            assert_eq!(route(token1, token0), Some((pool, false)));
            for &(other, other0, _) in &POOLS[i + 1..] {
                assert!(other != pool && other0 != token0);
            }
        }
        assert_eq!(route(WETH, WETH), None);
        assert_eq!(route(WETH, POOLS[1].1), None, "no multihop");
    }

    #[test]
    fn calldata_matches_independent_encoding() {
        // Independently encoded with `cast calldata` from Metric's documented
        // ExactInputSingleParams and quoter overload.
        assert_eq!(exactInputSingleCall::SELECTOR, [0x86, 0x5f, 0x50, 0x93]);
        assert_eq!(
            quoteLiveExactInSingleCall::SELECTOR,
            [0x67, 0xa0, 0x01, 0x05]
        );
        assert_eq!(getImmutablesCall::SELECTOR, [0xbc, 0xdb, 0x4d, 0xad]);
        assert_eq!(isPoolCall::SELECTOR, [0x5b, 0x16, 0xeb, 0xb7]);
        let one = U256::from(10u64.pow(18));
        let usdg = U256::from(2_000_000_000u64);
        let deadline = NOW + DEADLINE_SECS;
        let sell = calldata(WETH, USDG, one, usdg, SETTLEMENT, deadline).unwrap();
        assert_eq!(sell.len(), 4 + 32 * 12);
        assert_eq!(
            keccak256(&sell),
            b256!("7324ae42dcd607466d57953c0157c568fa0200f48e86fe62d147fc50bcb7620c")
        );
        let buy = calldata(USDG, WETH, usdg, one, SETTLEMENT, deadline).unwrap();
        assert_eq!(
            keccak256(&buy),
            b256!("8fcfdfe895977e866aaae575ecc8d47ea2549c59cba6a588c43c3b77b24699ba")
        );
        let quote = quoteLiveExactInSingleCall {
            pool: POOLS[0].0,
            sender: ROUTER,
            recipient: SETTLEMENT,
            zeroForOne: true,
            amountIn: 10u128.pow(18),
            priceLimitX64: price_limit(true),
            extensionData: Bytes::new(),
        }
        .abi_encode();
        assert_eq!(
            keccak256(quote),
            b256!("bff88998e1f9294f54db81173ae358525c5e54f3b47ac95224942dd0f22e79ae")
        );
        assert_eq!(
            decode(&sell, WETH, USDG, SETTLEMENT, NOW),
            Some((one, usdg))
        );
        assert_eq!(decode(&buy, USDG, WETH, SETTLEMENT, NOW), Some((usdg, one)));
    }

    #[test]
    fn encoder_rejects_out_of_range_amounts() {
        let max = U256::from(i128::MAX as u128);
        let ok = |input, minimum| calldata(WETH, USDG, input, minimum, SETTLEMENT, 1).is_some();
        assert!(ok(max, U256::from(u128::MAX)));
        assert!(
            !ok(max + U256::from(1), U256::from(1)),
            "int128 quoter bound"
        );
        assert!(!ok(U256::ZERO, U256::from(1)));
        assert!(!ok(U256::from(1), U256::ZERO));
        assert!(!ok(U256::from(1), U256::from(u128::MAX) + U256::from(1)));
        assert!(calldata(WETH, USDG, max, max, Address::ZERO, 1).is_none());
        assert!(calldata(WETH, USDG, max, max, SETTLEMENT, 0).is_none());
        assert!(calldata(WETH, POOLS[1].1, max, max, SETTLEMENT, 1).is_none());
    }

    #[test]
    fn decoder_binds_every_field_but_amounts_and_deadline() {
        let deadline = NOW + DEADLINE_SECS;
        let data = calldata(
            WETH,
            USDG,
            U256::from(1000),
            U256::from(990),
            SETTLEMENT,
            deadline,
        )
        .unwrap();
        let decode = |data: &[u8]| decode(data, WETH, USDG, SETTLEMENT, NOW);
        let expected = decode(&data);
        for index in 0..data.len() {
            let mut bad = data.clone();
            bad[index] ^= 1;
            let got = decode(&bad);
            if (180..196).contains(&index) || (212..228).contains(&index) {
                // Low uint128 bytes of amountIn (word 5) and amountOutMinimum
                // (word 6): still canonical, and returned for callers to bind.
                assert!(got.is_some() && got != expected, "byte {index}");
            } else if (290..292).contains(&index) {
                // Sub-window drift of the deadline (word 8) stays valid.
                assert_eq!(got, expected, "byte {index}");
            } else {
                assert_eq!(got, None, "byte {index}");
            }
        }
        let mut trailing = data.clone();
        trailing.push(0);
        assert_eq!(decode(&trailing), None);
        assert_eq!(decode(&data[..data.len() - 1]), None);
        assert_eq!(super::decode(&data, USDG, WETH, SETTLEMENT, NOW), None);
        assert_eq!(
            super::decode(&data, WETH, USDG, Address::repeat_byte(1), NOW),
            None
        );
        // Deadline window: (now, now + MAX_DEADLINE_SECS].
        assert!(decode(&data).is_some());
        assert!(super::decode(&data, WETH, USDG, SETTLEMENT, deadline).is_none());
        assert!(
            super::decode(&data, WETH, USDG, SETTLEMENT, deadline - MAX_DEADLINE_SECS).is_some()
        );
        assert!(
            super::decode(
                &data,
                WETH,
                USDG,
                SETTLEMENT,
                deadline - MAX_DEADLINE_SECS - 1
            )
            .is_none()
        );
        let mut call = exactInputSingleCall::abi_decode(&data).unwrap();
        call.params.deadline = U256::MAX;
        assert_eq!(decode(&call.abi_encode()), None);
    }
}
