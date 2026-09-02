// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title VoidTestOracle
/// @notice A TESTNET oracle with a declared price.
///
/// @dev    THIS DOES NOT GO TO MAINNET. There the price comes from
///         `VoidPriceOracle`, which composes the 30-minute TWAP of the VOID/ETH
///         pool with Chainlink's ETH/USD feed.
///
///         This one exists because neither source is available on testnet: there
///         is no VOID/ETH pool with any depth, and Robinhood's Chainlink feed is
///         a mainnet one. An oracle reading an empty pool would return garbage,
///         and a test over garbage proves nothing.
///
///         It exposes exactly the same interface as the production one, so the
///         rest of the system cannot tell the difference — it is one part being
///         swapped, not a parallel version of the code.
contract VoidTestOracle {
    address public governor;

    /// @notice How many VOID one ETH is worth, 18 decimals.
    uint256 public voidPerEth;
    /// @notice How much one VOID is worth in dollars, 18 decimals.
    uint256 public voidUsdPrice;

    event PriceUpdated(uint256 voidPerEth, uint256 voidUsd);

    error NotGovernor(address who);
    error ZeroPrice();

    constructor(address governor_, uint256 voidPerEth_, uint256 voidUsd_) {
        governor = governor_;
        voidPerEth = voidPerEth_;
        voidUsdPrice = voidUsd_;
    }

    function setPrice(uint256 voidPerEth_, uint256 voidUsd_) external {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        if (voidPerEth_ == 0 || voidUsd_ == 0) revert ZeroPrice();
        voidPerEth = voidPerEth_;
        voidUsdPrice = voidUsd_;
        emit PriceUpdated(voidPerEth_, voidUsd_);
    }

    function voidUsd() external view returns (uint256) {
        return voidUsdPrice;
    }

    /// @notice Converts dollars into VOID. This is what turns "a toll of $0.001"
    ///         into a chargeable amount.
    function usdToVoid(uint256 usdAmount) external view returns (uint256) {
        return (usdAmount * 1e18) / voidUsdPrice;
    }
}
