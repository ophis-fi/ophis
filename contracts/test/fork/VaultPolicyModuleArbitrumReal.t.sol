// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "src/contracts/interfaces/IERC20.sol";
import {GPv2Order} from "src/contracts/libraries/GPv2Order.sol";
import {OphisVaultPolicyModule} from "src/contracts/vault/OphisVaultPolicyModule.sol";
import {OphisVaultPolicyModuleFactory} from "src/contracts/vault/OphisVaultPolicyModuleFactory.sol";
import {IAggregatorV3, IGPv2Settlement, ISafe} from "src/contracts/vault/interfaces/IVaultPolicyDeps.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function enableModule(address module) external;
    function isModuleEnabled(address module) external view returns (bool);
}

/// @title Preflight: the vault policy module against REAL Arbitrum state.
/// @notice Mirrors the Base preflight for Arbitrum One (42161), CoW-HOSTED: the
/// module is constructed against the CANONICAL GPv2 settlement + relayer, the
/// REAL Arbitrum Chainlink ETH/USD + USDC/USD feeds (8-decimal) and the REAL
/// Arbitrum sequencer-uptime feed, on an Arbitrum fork. Proves:
/// the feed liveness probe passes; a legit rebalance presigns in the real
/// settlement with exact allowance; the real oracle produces a nonzero floor
/// (below-floor reverts); a drain order is rejected. Gate before the Arbitrum
/// mainnet deploy.
///
/// Run: OPHIS_FORK_RPC_ARBITRUM=https://arb1.arbitrum.io/rpc forge test \
///        --match-path 'test/fork/VaultPolicyModuleArbitrumReal.t.sol'
contract VaultPolicyModuleArbitrumReal is Test {
    // Canonical Safe v1.3.0 (same on every chain).
    address internal constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address internal constant SAFE_L2_SINGLETON = 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA;
    address internal constant SAFE_FALLBACK = 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4;

    // Arbitrum One (42161) production addresses (verified against live state).
    address internal constant SETTLEMENT = 0x9008D19f58AAbD9eD0D60971565AA8510560ab41; // canonical
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // native, 6 dec
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // 18 dec
    address internal constant USDC_USD_FEED = 0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3; // 8 dec
    address internal constant ETH_USD_FEED = 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612; // 8 dec
    address internal constant SEQUENCER_FEED = 0xFdB631F5EE196F0ed6FAa767959853A9F217697D;

    // ETH/USD is deviation-driven, updating every few minutes in practice, so
    // the tight OP/Base window applies; USDC/USD is a 24h-heartbeat stable feed
    // (see the deploy script).
    uint256 internal constant USDC_STALENESS = 26 hours;
    uint256 internal constant ETH_STALENESS = 2 hours;
    uint256 internal constant USDC_MIN_PRICE18 = 25e16;
    uint256 internal constant USDC_MAX_PRICE18 = 4e18;
    uint256 internal constant ETH_MIN_PRICE18 = 500e18;
    uint256 internal constant ETH_MAX_PRICE18 = 8000e18;
    uint256 internal constant SEQ_GRACE = 1 hours;

    address internal constant CURATOR = address(0xC0FFEE);
    address internal constant SAFE_OWNER = address(0xA11CE);
    bytes32 internal constant APP_DATA = keccak256("ophis-arbitrum-appdata");

    ISafeSetup internal safe;
    OphisVaultPolicyModule internal module;

    function setUp() public {
        string memory rpc = vm.envOr("OPHIS_FORK_RPC_ARBITRUM", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);

        address[] memory owners = new address[](1);
        owners[0] = SAFE_OWNER;
        bytes memory initializer = abi.encodeWithSelector(
            ISafeSetup.setup.selector,
            owners,
            uint256(1),
            address(0),
            bytes(""),
            SAFE_FALLBACK,
            address(0),
            uint256(0),
            payable(address(0))
        );
        address proxy = ISafeProxyFactory(SAFE_FACTORY)
            .createProxyWithNonce(SAFE_L2_SINGLETON, initializer, uint256(keccak256("ophis-arbitrum-preflight")));
        safe = ISafeSetup(proxy);

        OphisVaultPolicyModule.TokenFeed[] memory tokens = new OphisVaultPolicyModule.TokenFeed[](2);
        tokens[0] = OphisVaultPolicyModule.TokenFeed(
            USDC, IAggregatorV3(USDC_USD_FEED), USDC_STALENESS, USDC_MIN_PRICE18, USDC_MAX_PRICE18
        );
        tokens[1] = OphisVaultPolicyModule.TokenFeed(
            WETH, IAggregatorV3(ETH_USD_FEED), ETH_STALENESS, ETH_MIN_PRICE18, ETH_MAX_PRICE18
        );

        // EXACT production config. A passing setUp proves the real feeds serve a
        // fresh price, the sequencer feed reports up, and the canonical
        // settlement is live at the configured address.
        OphisVaultPolicyModuleFactory factory = new OphisVaultPolicyModuleFactory();
        module = factory.deploy(
            OphisVaultPolicyModule.ModuleConfig({
                safe: ISafe(proxy),
                settlement: IGPv2Settlement(SETTLEMENT),
                curator: CURATOR,
                appDataHash: APP_DATA,
                maxSlippageBps: 50,
                maxTtl: 1980, // matches the deploy script: builder 1800s TTL + 180s block-ts lag margin
                dailyUsdTurnoverCap: 1_000e18,
                sequencerUptimeFeed: IAggregatorV3(SEQUENCER_FEED),
                allowNoSequencerFeed: false,
                sequencerGracePeriod: SEQ_GRACE,
                tokens: tokens
            })
        );
        vm.prank(proxy);
        safe.enableModule(address(module));
    }

    function _forked() internal view returns (bool) {
        return address(module) != address(0);
    }

    function _order(address receiver, uint256 buyAmount) internal view returns (GPv2Order.Data memory) {
        return GPv2Order.Data({
            sellToken: IERC20(USDC),
            buyToken: IERC20(WETH),
            receiver: receiver,
            sellAmount: 100e6, // 100 USDC
            buyAmount: buyAmount,
            validTo: uint32(block.timestamp + 1800),
            appData: APP_DATA,
            feeAmount: 0,
            kind: GPv2Order.KIND_SELL,
            partiallyFillable: false,
            sellTokenBalance: GPv2Order.BALANCE_ERC20,
            buyTokenBalance: GPv2Order.BALANCE_ERC20
        });
    }

    /// The module constructed against REAL feeds (probe passed) and a legit
    /// rebalance presigns in the REAL canonical settlement with exact allowance.
    function test_arbitrum_real_construct_and_presign() public {
        if (!_forked()) vm.skip(true);
        assertTrue(safe.isModuleEnabled(address(module)));
        GPv2Order.Data memory order = _order(address(safe), 1e30);
        vm.prank(CURATOR);
        bytes memory uid = module.rebalance(order, 0);
        IGPv2Settlement s = IGPv2Settlement(SETTLEMENT);
        assertEq(s.preSignature(uid), uint256(keccak256("GPv2Signing.Scheme.PreSign")));
        assertEq(IERC20(USDC).allowance(address(safe), s.vaultRelayer()), 100e6);
    }

    /// The REAL oracle produces a nonzero floor: a 1-wei buyAmount reverts
    /// BelowFloor (proves read18 against the real 8-decimal feeds works).
    function test_arbitrum_real_below_floor_reverts() public {
        if (!_forked()) vm.skip(true);
        vm.prank(CURATOR);
        vm.expectRevert(); // BelowFloor(1, realFloor)
        module.rebalance(_order(address(safe), 1), 0);
    }

    /// A drain order (attacker receiver) is rejected on-chain.
    function test_arbitrum_real_drain_rejected() public {
        if (!_forked()) vm.skip(true);
        vm.prank(CURATOR);
        vm.expectRevert(OphisVaultPolicyModule.ReceiverNotSafe.selector);
        module.rebalance(_order(address(0xBAD), 1e30), 0);
    }
}
