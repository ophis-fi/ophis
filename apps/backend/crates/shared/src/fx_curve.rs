//! Published f(x) fxUSD StableSwap-NG pools on Ethereum, checked 2026-10-20.
//! Provenance: https://fxprotocol.gitbook.io/fx-docs/more/resources/contracts
//! Ordered coins cross-checked with Curve's API and authenticated onchain.
use alloy::primitives::{Address, address};

pub const FXUSD: Address = address!("085780639CC2cACd35E474e71f4d000e2405d8f6");
// shortcut: published two-coin stable pools only; review a new pool's ABI and coin order before adding it.
pub const POOLS: &[(Address, [Address; 2])] = &[
    // crvUSD/fxUSD
    (
        address!("8fFC7b89412eFD0D17EDEa2018F6634eA4C2FCb2"),
        [address!("f939E0A03FB07F59A73314E73794Be0E57ac1b4E"), FXUSD],
    ),
    // pyUSD/fxUSD
    (
        address!("d6982da59F1D26476E259559508f4135135cf9b8"),
        [address!("6c3ea9036406852006290770BEdFcAbA0e23A0e8"), FXUSD],
    ),
    // Dola/fxUSD
    (
        address!("189B4e49B5cAf33565095097b4B960F14032C7D0"),
        [address!("865377367054516e17014CcdED1e7d814EDC9ce4"), FXUSD],
    ),
    // Grai/fxUSD
    (
        address!("69Cf42F15F9325986154b61A013da6E8feC82CCF"),
        [address!("15f74458aE0bFdAA1a96CA1aa779D715Cc1Eefe4"), FXUSD],
    ),
    // Frax/fxUSD
    (
        address!("1EE81c56e42EC34039D993d12410d437DdeA341E"),
        [address!("853d955aCEf822Db058eb8505911ED77F175b99e"), FXUSD],
    ),
    // GHO/fxUSD
    (
        address!("74345504Eaea3D9408fC69Ae7EB2d14095643c5b"),
        [address!("40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f"), FXUSD],
    ),
    // eUSD/fxUSD
    (
        address!("16b54e3aC8e3ba088333985035b869847e36E770"),
        [address!("A0d69E286B938e21CBf7E51D71F6A4c8918f482F"), FXUSD],
    ),
    // mkUSD/fxUSD
    (
        address!("cA554E2e2948a211D4650Fe0F4E271f01f9cB5F1"),
        [address!("4591DBfF62656E7859Afe5e45f6f47D3669fBB28"), FXUSD],
    ),
    // ULTRA/fxUSD
    (
        address!("F33aB11E5C4e55DAcB13644f0C0A9d1e199A796F"),
        [address!("35282d87011f87508D457F08252Bc5bFa52E10A0"), FXUSD],
    ),
    // rev fxUSD
    (
        address!("6fC7eA6CA8Cd2759803eb78159C931a8FF5E0557"),
        [address!("78da5799CF427Fee11e9996982F4150eCe7a99A7"), FXUSD],
    ),
    // fxUSD/rUSD
    (
        address!("2116BFaD62b383043230501f6a124c6EA60CcfA5"),
        [FXUSD, address!("65D72AA8DA931F047169112fcf34f52DbaAE7D18")],
    ),
    // alUSD/fxUSD
    (
        address!("27cB9629aE3Ee05cb266B99cA4124EC999303c9D"),
        [address!("BC6DA0FE9aD5f3b0d58160288917AA56653660E9"), FXUSD],
    ),
    // MIM/fxUSD
    (
        address!("D7Bf9bb6Bd088317Effd116E2B70ea3A054cBceb"),
        [address!("99D8a9C45b2ecA8864373A26D1459e3Dff1e17F3"), FXUSD],
    ),
    // zunUSD/fxUSD
    (
        address!("13eA95Ce68185e334d3747539845A3b7643a8cab"),
        [address!("8C0D76C9B18779665475F3E212D9Ca1Ed6A1A0e6"), FXUSD],
    ),
    // USDC/fxUSD
    (
        address!("5018BE882DccE5E3F2f3B0913AE2096B9b3fB61f"),
        [address!("A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), FXUSD],
    ),
    // USD0/FXUSD
    (
        address!("74c204520c9e88aA3EB9d61788ABA11Be1e0193F"),
        [address!("73A15FeD60Bf67631dC6cd7Bc5B6e8da8190aCF5"), FXUSD],
    ),
];

pub fn coins(pool: Address) -> Option<&'static [Address; 2]> {
    POOLS
        .iter()
        .find(|(address, _)| *address == pool)
        .map(|(_, coins)| coins)
}
