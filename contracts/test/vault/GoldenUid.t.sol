// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

import {MockFeed, MockSafe, MockSettlement} from "./Mocks.sol";

/// @dev Storage-free ERC20 stand-in so it can be `vm.etch`ed at a fixed
/// address (the golden vector pins the token addresses).
contract GoldenToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @title Cross-language golden uid vector
/// @notice Two-link chain of trust:
///  1. LIBRARY <-> TYPESCRIPT: the vendored GPv2Order.hash +
///     packOrderUidParams under the OP settlement domain reproduce, byte for
///     byte, the golden uid asserted by the ophis safe-swap TypeScript
///     `computeOrderUid` (packages/safe-swap/test/order.test.ts), itself
///     cross-checked against ethers v6 TypedDataEncoder. Three independent
///     implementations, one uid.
///  2. MODULE <-> LIBRARY: the module's rebalance() presigns exactly the uid
///     the library derives for the same order at the same pinned addresses.
///     (The module test uses a NONZERO appData because the module rejects
///     the zero appData hash by policy - the fee invariant must never be
///     silently disabled - while the TS golden vector predates that rule.)
contract GoldenUidTest is Test {
    // The exact order from the TS golden test: assembleVaultOrder(baseQuote)
    // on OP (chainId 10, Ophis settlement 0x310784c7...B859).
    address internal constant SELL = 0x1111111111111111111111111111111111111111;
    address internal constant BUY = 0x2222222222222222222222222222222222222222;
    address internal constant SAFE = 0x3333333333333333333333333333333333333333;
    address internal constant OP_SETTLEMENT = 0x310784c7FCE12d578dA6f53460777bAc9718B859;
    uint32 internal constant VALID_TO = 1_000_001_800; // nowSeconds 1e9 + TTL 1800
    address internal constant CURATOR = address(0xCA11);
    address internal constant RELAYER = address(0xBEEF00000000000000000000000000000000BEEf);
    bytes32 internal constant MODULE_APP_DATA = keccak256("ophis-golden-appdata");

    bytes internal constant GOLDEN_UID =
        hex"1e4a566ea52b5671d8ff0b5a5a589772c1a0b659e6838b41ce07249768dcf3d133333333333333333333333333333333333333333b9ad108";

    function opDomainSeparator() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Gnosis Protocol")),
                keccak256(bytes("v2")),
                uint256(10),
                OP_SETTLEMENT
            )
        );
    }

    function goldenOrder(bytes32 appData) internal pure returns (GPv2Order.Data memory) {
        return GPv2Order.Data({
            sellToken: IERC20(SELL),
            buyToken: IERC20(BUY),
            receiver: SAFE,
            sellAmount: 1_000_000, // gross = quote 999000 + fee 1000
            buyAmount: 1_990_000, // 2_000_000 * 9950 / 10000
            validTo: VALID_TO,
            appData: appData,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
    }

    function test_library_uid_matches_typescript_golden_vector() public pure {
        // The TS golden order carries the zero appData hash.
        bytes32 digest = GPv2Order.hash(goldenOrder(bytes32(0)), opDomainSeparator());
        bytes memory uid = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(uid, digest, SAFE, VALID_TO);
        assertEq(uid, GOLDEN_UID);
    }

    function test_module_presigns_the_library_derived_uid() public {
        vm.warp(1_000_000_000);

        // Pin the golden addresses: a Safe at 0x3333... and tokens at
        // 0x1111... / 0x2222... via vm.etch (storage-free contracts).
        address[] memory noOwners = new address[](0);
        vm.etch(SAFE, address(new MockSafe(noOwners)).code);
        GoldenToken impl = new GoldenToken();
        vm.etch(SELL, address(impl).code);
        vm.etch(BUY, address(impl).code);

        MockSettlement settlement = new MockSettlement(opDomainSeparator(), RELAYER);
        MockFeed feed = new MockFeed(8, 1e8, block.timestamp);
        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(SELL, IAggregatorV3(address(feed)), 3600, 25e16, 4e18);
        tokens[1] = OphisVaultPolicyModule.TokenFeed(BUY, IAggregatorV3(address(feed)), 3600, 25e16, 4e18);

        OphisVaultPolicyModule module = new OphisVaultPolicyModule(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(SAFE),
                settlement: IGPv2Settlement(address(settlement)),
                curator: CURATOR,
                appDataHash: MODULE_APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1800,
                dailyUsdTurnoverCap: 1_000_000e18,
                sequencerUptimeFeed: IAggregatorV3(address(0)),
                sequencerGracePeriod: 0,
                tokens: tokens
            })
        );

        GPv2Order.Data memory order = goldenOrder(MODULE_APP_DATA);
        vm.prank(CURATOR);
        bytes memory uid = module.rebalance(order, 0);

        // The module presigned exactly the uid the (TS-golden-locked)
        // library derives for this order under this domain.
        bytes32 digest = GPv2Order.hash(order, opDomainSeparator());
        bytes memory expected = new bytes(GPv2Order.UID_LENGTH);
        GPv2Order.packOrderUidParams(expected, digest, SAFE, VALID_TO);
        assertEq(uid, expected);
        // And the settlement (enforcing real owner-==-msg.sender semantics)
        // recorded the presignature under that exact uid.
        assertEq(settlement.preSignature(expected), settlement.PRE_SIGNED());
        assertEq(GoldenToken(SELL).allowance(SAFE, RELAYER), 1_000_000);
    }
}
