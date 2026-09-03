// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Immutable testnet ETH/USD feed used only where a live Chainlink
/// feed is unavailable. There is no setter or governor price override.
contract VoidFixedEthUsdFeedV6 {
    uint8 public constant decimals = 8;
    int256 public immutable answer;

    constructor(int256 answer_) {
        require(answer_ > 0, "bad answer");
        answer = answer_;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
