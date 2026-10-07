// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity >=0.7.6 <0.9.0;
pragma abicoder v2;

import {GPv2AllowListAuthentication} from "../src/contracts/GPv2AllowListAuthentication.sol";
import {GPv2Settlement} from "../src/contracts/GPv2Settlement.sol";
import {OphisFeeLiquidator} from "../src/contracts/OphisFeeLiquidator.sol";
import {GPv2Authentication} from "../src/contracts/interfaces/GPv2Authentication.sol";
import {IVault} from "../src/contracts/interfaces/IVault.sol";

/// @dev Standalone ERC20 for this harness. Deliberately does NOT inherit
/// IERC20: interface-inherited NatSpec on public state variables produces
/// `devdoc.stateVariables` output that crytic-compile 0.4.x fails to
/// serialize (DevStateVariable JSON bug), killing the echidna run. The ABI
/// is what matters, the liquidator talks to it through IERC20 selectors.
contract HarnessERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "HarnessERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "HarnessERC20: allowance");
        require(balanceOf[from] >= amount, "HarnessERC20: balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @dev Fixed-rate (1:1) venue used by the harness. Pulls the requested
/// input via the settlement's exact approval and pays output from its own
/// inventory to the requested recipient.
contract FixedRateVenue {
    function swap(HarnessERC20 tokenIn, uint256 amountIn, HarnessERC20 tokenOut, address recipient) external {
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        require(tokenOut.transfer(recipient, amountIn), "FixedRateVenue: payout");
    }
}

/// @dev Echidna harness for OphisFeeLiquidator (fee-ops Wave 2).
///
/// Model: the harness is BOTH the owner and the liquidator of the contract
/// under test, so the fuzz wrappers below exercise the real ops surface
/// (liquidator-role sweep + owner-role consolidate, both through empty-trade
/// settle() post-interactions on a real GPv2Settlement). What is fuzzed is the
/// FUNDS-FLOW SAFETY once a call is authorized, not access control: the forge
/// suite pins the auth matrix, including that consolidate() is owner-only and
/// the hot-key drain is impossible. Here the conservation properties must hold
/// no matter which authorized entry point runs:
///
///   echidna_liquidator_holds_nothing, the liquidator contract never
///       custodies tokens or ETH, in any reachable state;
///   echidna_token_in_conserved / echidna_token_out_conserved, tokens only
///       ever sit with the Settlement, the fee Safe, or the venue: no
///       call sequence can leak value to any other address;
///   echidna_eth_conserved, native ETH funded into the Settlement only
///       ever ends up in the Settlement or the fee Safe;
///   echidna_no_allowance_at_rest, the settlement->venue allowance is zero
///       between transactions (the same-settle revoke holds).
///
/// The same invariants are also `assert`ed inside every wrapper so the
/// harness trips in `testMode: assertion` (the repo's echidna.yaml) as well
/// as in property mode.
contract E2EFeeLiquidator {
    address payable internal constant FEE_SAFE = payable(address(0xF5AFE));
    uint256 internal constant MINT_CAP = 1e30;
    uint256 internal constant STEP_CAP = 1e24;

    GPv2AllowListAuthentication internal allowList;
    GPv2Settlement internal settlement;
    OphisFeeLiquidator internal liq;
    HarnessERC20 internal tokenIn;
    HarnessERC20 internal tokenOut;
    FixedRateVenue internal venue;

    uint256 internal mintedIn;
    uint256 internal mintedOut;
    uint256 internal fundedEth;

    constructor() {
        allowList = new GPv2AllowListAuthentication();
        allowList.initializeManager(address(this));
        settlement = new GPv2Settlement(GPv2Authentication(address(allowList)), IVault(address(0)));
        liq = new OphisFeeLiquidator(settlement, FEE_SAFE, address(this), address(this));
        allowList.addSolver(address(liq));

        tokenIn = new HarnessERC20();
        tokenOut = new HarnessERC20();
        venue = new FixedRateVenue();
        liq.setVenue(address(venue), true);
        liq.setOutputToken(address(tokenOut), true);
        // Both harness tokens are sweepable (sweep now requires an allowlist
        // entry per non-native token); native ETH needs none. Keeps the
        // sweepIn/sweepOut/sweepAll entry points reachable so the conservation
        // invariants are actually exercised.
        liq.setSweepToken(address(tokenIn), true);
        liq.setSweepToken(address(tokenOut), true);

        // Venue payout inventory (counted in the conservation baseline).
        tokenOut.mint(address(venue), MINT_CAP);
        mintedOut = MINT_CAP;
    }

    // --- fuzz entry points ---

    function fundIn(uint256 amount) external {
        amount = (amount % STEP_CAP) + 1;
        if (mintedIn + amount > MINT_CAP) {
            return;
        }
        tokenIn.mint(address(settlement), amount);
        mintedIn += amount;
        checkInvariants();
    }

    function fundEth(uint256 amount) external {
        uint256 available = address(this).balance;
        if (available == 0) {
            return;
        }
        amount = (amount % available) + 1;
        if (amount > available) {
            return;
        }
        // solhint-disable-next-line avoid-low-level-calls
        (bool ok,) = address(settlement).call{value: amount}("");
        require(ok, "E2EFeeLiquidator: fund failed");
        fundedEth += amount;
        checkInvariants();
    }

    function sweepIn(uint256 amount) external {
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenIn);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount % (tokenIn.balanceOf(address(settlement)) + 1);
        liq.sweep(tokens, amounts);
        checkInvariants();
    }

    function sweepOut(uint256 amount) external {
        address[] memory tokens = new address[](1);
        tokens[0] = address(tokenOut);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount % (tokenOut.balanceOf(address(settlement)) + 1);
        liq.sweep(tokens, amounts);
        checkInvariants();
    }

    function sweepAll() external {
        address[] memory tokens = new address[](3);
        tokens[0] = address(tokenIn);
        tokens[1] = address(tokenOut);
        tokens[2] = address(0); // native ETH
        uint256[] memory amounts = new uint256[](3); // all-zero = full balances
        liq.sweep(tokens, amounts);
        checkInvariants();
    }

    function consolidate(uint256 pullSeed, uint256 minOutSeed) external {
        uint256 balIn = tokenIn.balanceOf(address(settlement));
        uint256 pull = pullSeed % (balIn + 1);
        uint256 minOut = (minOutSeed % (balIn + 1)) + 1;
        OphisFeeLiquidator.ConsolidateInput[] memory inputs = new OphisFeeLiquidator.ConsolidateInput[](1);
        inputs[0] = OphisFeeLiquidator.ConsolidateInput({token: address(tokenIn), amount: 0});
        bytes memory data =
            abi.encodeWithSelector(FixedRateVenue.swap.selector, tokenIn, pull, tokenOut, address(settlement));
        liq.consolidate(inputs, address(tokenOut), minOut, address(venue), data);
        checkInvariants();
    }

    // --- invariants ---

    function invariantLiquidatorHoldsNothing() internal view returns (bool) {
        return
            tokenIn.balanceOf(address(liq)) == 0 && tokenOut.balanceOf(address(liq)) == 0 && address(liq).balance == 0;
    }

    function invariantTokenInConserved() internal view returns (bool) {
        return tokenIn.balanceOf(address(settlement)) + tokenIn.balanceOf(FEE_SAFE) + tokenIn.balanceOf(address(venue))
            == mintedIn;
    }

    function invariantTokenOutConserved() internal view returns (bool) {
        return tokenOut.balanceOf(address(settlement)) + tokenOut.balanceOf(FEE_SAFE)
                + tokenOut.balanceOf(address(venue)) == mintedOut;
    }

    function invariantEthConserved() internal view returns (bool) {
        return address(settlement).balance + FEE_SAFE.balance == fundedEth;
    }

    function invariantNoAllowanceAtRest() internal view returns (bool) {
        return tokenIn.allowance(address(settlement), address(venue)) == 0
            && tokenOut.allowance(address(settlement), address(venue)) == 0;
    }

    function checkInvariants() internal view {
        assert(invariantLiquidatorHoldsNothing());
        assert(invariantTokenInConserved());
        assert(invariantTokenOutConserved());
        assert(invariantEthConserved());
        assert(invariantNoAllowanceAtRest());
    }

    // Property-mode mirrors (prefix matches the sibling harnesses).

    function echidna_liquidator_holds_nothing() public view returns (bool) {
        return invariantLiquidatorHoldsNothing();
    }

    function echidna_token_in_conserved() public view returns (bool) {
        return invariantTokenInConserved();
    }

    function echidna_token_out_conserved() public view returns (bool) {
        return invariantTokenOutConserved();
    }

    function echidna_eth_conserved() public view returns (bool) {
        return invariantEthConserved();
    }

    function echidna_no_allowance_at_rest() public view returns (bool) {
        return invariantNoAllowanceAtRest();
    }

    // Echidna's balanceContract funds this harness with ETH for fundEth.
    receive() external payable {}
}
