// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;
import {Test} from "forge-std/Test.sol";

interface ITokenDirectTest {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract DirectVenuesTest is Test {
    address constant RWETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant OP_USDC = 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address constant UNI_USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;

    struct V3Venue {
        address factory;
        address quoter;
        address router;
        bool cl;
    }

    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    struct LeafRoute {
        address from;
        address to;
        bool stable;
    }

    function testPancakeV3() external {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC"));
        assertTrue(
            v3(
                V3Venue(
                    0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865,
                    0x8553AA1615549A86882151784b329B017aA7c832,
                    0x13f4EA83D0bd40E75C8222255bc855a974568Dd4,
                    false
                ),
                RWETH,
                USDG
            ),
            "no executable Pancake pool"
        );
    }

    function testRamsesV3() external {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC"));
        address factory = 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8;
        address quoter = 0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6;
        address router = 0xFCBBe2Af83F94e7E2a9C35a535B3A04719aFD2Ae;
        bool ok = v3(V3Venue(factory, quoter, router, true), RWETH, USDG);
        if (!ok) ok = v3(V3Venue(factory, quoter, router, true), RWETH, 0x5173D45A1191eE33cBB7D8c7e65f21B04eD54802);
        assertTrue(ok, "no executable Ramses pool");
    }

    function testVelodromeSlipstream() external {
        vm.createSelectFork(vm.envString("OP_MAINNET_RPC"));
        assertTrue(
            v3(
                V3Venue(
                    0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F,
                    0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466,
                    0x0792a633F0c19c351081CF4B211F68F79bCc9676,
                    true
                ),
                WETH,
                OP_USDC
            ),
            "no executable Slipstream pool"
        );
    }

    function testVelodromeOptimismV2() external {
        vm.createSelectFork(vm.envString("OP_MAINNET_RPC"));
        assertTrue(
            solidly(
                0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858,
                0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a,
                WETH,
                OP_USDC,
                false
            ),
            "no executable Velodrome V2 pool"
        );
    }

    function testVelodromeUnichainV2() external {
        vm.createSelectFork(vm.envString("UNICHAIN_RPC"));
        address router = 0x3a63171DD9BebF4D07BC782FECC7eb0b890C2A45;
        address factory = 0x31832f2a97Fd20664D76Cc421207669b55CE4BC0;
        bool ok = solidly(router, factory, WETH, UNI_USDC, true);
        if (!ok) ok = solidly(router, factory, WETH, 0x7f9AdFbd38b669F03d1d11000Bc76b9AaEA28A81, true);
        assertTrue(ok, "no executable Velodrome Unichain pool");
    }

    function testUp33() external {
        vm.createSelectFork(vm.envString("ROBINHOOD_RPC"));
        assertTrue(
            solidly(
                0xf5198743240fAC98db71868F34c70139b1eb0474,
                0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28,
                RWETH,
                USDG,
                false
            ),
            "no executable UP33 pool"
        );
    }

    function v3(V3Venue memory venue, address sell, address buy) internal returns (bool) {
        uint256[12] memory tiers = [uint256(1), 5, 10, 50, 60, 100, 200, 500, 2500, 10000, 2000, 1000];
        uint256 amount = 0.0001 ether;
        for (uint256 i; i < tiers.length; i++) {
            uint256 tier = tiers[i];
            uint256 out;
            {
                bytes4 lookup = venue.cl ? bytes4(0x28af8d0b) : bytes4(0x1698ee82);
                (bool exists, bytes memory pool) =
                    venue.factory.staticcall(abi.encodeWithSelector(lookup, sell, buy, tier));
                if (!exists || pool.length != 32 || abi.decode(pool, (address)) == address(0)) continue;
                bytes4 qs = venue.cl ? bytes4(0x9e7defe6) : bytes4(0xc6a5026a);
                (bool quoted, bytes memory data) =
                    venue.quoter.call(abi.encodeWithSelector(qs, sell, buy, amount, tier, uint256(0)));
                if (!quoted || data.length != 128) continue;
                (out,,,) = abi.decode(data, (uint256, uint160, uint32, uint256));
            }
            if (out == 0) continue;
            uint256 min = out * 99 / 100;
            bytes memory callData = venue.cl
                ? abi.encodeWithSelector(
                    bytes4(0xa026383e), sell, buy, tier, address(this), type(uint256).max, amount, min, uint256(0)
                )
                : abi.encodeWithSelector(bytes4(0x04e45aaf), sell, buy, tier, address(this), amount, min, uint256(0));
            execute(venue.router, sell, buy, amount, min, callData);
            emit log_named_uint("selected tier", tier);
            return true;
        }
        return false;
    }

    function solidly(address router, address factory, address sell, address buy, bool leaf) internal returns (bool) {
        uint256 amount = 0.0001 ether;
        for (uint256 i; i < 2; i++) {
            Route[] memory routes = new Route[](1);
            routes[0] = Route(sell, buy, i == 1, factory);
            LeafRoute[] memory leaves = new LeafRoute[](1);
            leaves[0] = LeafRoute(sell, buy, i == 1);
            uint256 min;
            {
                bytes memory q = leaf
                    ? abi.encodeWithSignature("getAmountsOut(uint256,(address,address,bool)[])", amount, leaves)
                    : abi.encodeWithSignature("getAmountsOut(uint256,(address,address,bool,address)[])", amount, routes);
                (bool ok, bytes memory data) = router.staticcall(q);
                if (!ok || data.length < 128) continue;
                uint256[] memory amounts = abi.decode(data, (uint256[]));
                if (amounts.length != 2 || amounts[1] == 0) continue;
                min = amounts[1] * 99 / 100;
            }
            bytes memory c = leaf
                ? abi.encodeWithSelector(bytes4(0xf41766d8), amount, min, leaves, address(this), type(uint256).max)
                : abi.encodeWithSelector(bytes4(0xcac88ea9), amount, min, routes, address(this), type(uint256).max);
            execute(router, sell, buy, amount, min, c);
            return true;
        }
        return false;
    }

    function execute(address router, address sell, address buy, uint256 amount, uint256 min, bytes memory data)
        internal
    {
        deal(sell, address(this), amount);
        ITokenDirectTest(sell).approve(router, amount);
        uint256 beforeBalance = ITokenDirectTest(buy).balanceOf(address(this));
        (bool ok, bytes memory reason) = router.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        assertGe(ITokenDirectTest(buy).balanceOf(address(this)) - beforeBalance, min);
        assertEq(ITokenDirectTest(sell).balanceOf(address(this)), 0, "input must be consumed");
    }
}
