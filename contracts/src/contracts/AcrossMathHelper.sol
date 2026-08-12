// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.8;

/// @title AcrossMathHelper
///
/// @notice Weiroll math helper for the CoW <> Across bridge deposit calc.
///
/// The CoW `sdk-bridging` Across provider builds the SpokePool `depositV3` call
/// inside a CoW-Shed delegatecall using weiroll (an onchain calldata planner).
/// Weiroll can only CALL a deployed contract, never run inline arithmetic, so
/// the one piece of math it needs - scaling the deposit amount down by Across's
/// quoted relay-fee percentage - must live at a real address on the SOURCE
/// chain. The SDK looks that address up per chain in
/// `ACROSS_MATH_CONTRACT_ADDRESSES`; it ships only for mainnet / arbitrum /
/// base, and `getMathContract` THROWS on any other source. Enabling a new
/// Across source chain (here: Ink 57073, Linea 59144) therefore requires
/// deploying this helper on that chain and registering its address.
///
/// @dev This is a byte-faithful reimplementation of the canonical helper Across
/// / CoW already run on mainnet at 0xf2ae6728b6f146556977Af0A68bFbf5bADA22863
/// (verified by disassembling its runtime bytecode, selector 0x029beb8e). The
/// formula is `_a - (_a * _b) / 1e18`, NOT `_a * (1e18 - _b) / 1e18`: it floors
/// the fee term, so the surviving output amount rounds 1 wei UP relative to the
/// SDK's off-chain `applyPctFee` quote. Matching the deployed contract exactly
/// keeps Ink/Linea bridges behaving identically to the mainnet corridors rather
/// than forking rounding by a wei. `test/AcrossMathHelper.t.sol` fork-asserts
/// output equivalence against the live mainnet contract across fuzzed inputs.
contract AcrossMathHelper {
    /// @notice Reduce `_a` by the fraction `_b`, where `_b` is an 18-decimal
    /// fixed-point percentage (1e18 == 100%).
    /// @param _a The amount to scale (the deposit amount including surplus).
    /// @param _b The relay-fee fraction to subtract, 1e18 == 100%.
    /// @return result `_a - (_a * _b) / 1e18`.
    function multiplyAndSubtract(uint256 _a, uint256 _b) external pure returns (uint256 result) {
        require(_b <= 1e18, "Fraction _b must not exceed 1e18 (100%)");
        // Checked arithmetic (solc >=0.8): `_b <= 1e18` guarantees the product
        // term is <= `_a`, so the subtraction cannot underflow.
        result = _a - (_a * _b) / 1e18;
    }
}
