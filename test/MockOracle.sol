// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A test oracle, calibrated so that VOID = $1.
///
/// @dev    The calibration is not arbitrary: with VOID worth exactly one dollar,
///         `usdToVoid(x) == x`, and all the arithmetic of the tests written when
///         the toll was denominated in VOID keeps holding without a rewrite.
///         What those files test is fee conservation and isolation, not currency
///         conversion — the conversion has tests of its own.
contract MockOracle {
    uint256 public voidPerEth = 10_000e18;
    uint256 public voidUsdPrice = 1e18;

    function setVoidPerEth(uint256 v) external { voidPerEth = v; }
    function setVoidUsd(uint256 v) external { voidUsdPrice = v; }

    function voidUsd() external view returns (uint256) { return voidUsdPrice; }

    function usdToVoid(uint256 usdAmount) external view returns (uint256) {
        return (usdAmount * 1e18) / voidUsdPrice;
    }
}
