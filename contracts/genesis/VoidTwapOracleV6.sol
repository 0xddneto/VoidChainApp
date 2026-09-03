// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IVoidTwapPoolV6 {
    function observe() external view returns (uint256 cumulative, uint32 timestamp);
}

interface IAggregatorV3V6 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title VoidTwapOracleV6
/// @notice Permissionless TWAP publisher for VOID/ETH and an ETH/USD feed.
/// @dev The Paymaster sees zero until this oracle has observed a full interval;
/// it will refuse sponsorship instead of using a manipulable first-block spot.
contract VoidTwapOracleV6 {
    uint256 public constant USD_SCALE = 1e18;

    IVoidTwapPoolV6 public immutable pool;
    IAggregatorV3V6 public immutable ethUsdFeed;
    uint32 public immutable minInterval;
    uint32 public immutable maxFeedAge;
    uint8 public immutable ethUsdDecimals;

    uint256 public lastCumulative;
    uint32 public lastTimestamp;
    uint256 public twapVoidPerEth;

    event Bootstrapped(uint256 cumulative, uint32 timestamp);
    event Updated(uint256 voidPerEth, uint32 elapsed);

    error AlreadyBootstrapped();
    error NotBootstrapped();
    error IntervalTooShort(uint32 elapsed, uint32 minimum);
    error BadCumulative();
    error BadEthUsdAnswer();
    error StaleEthUsd(uint256 updatedAt);
    error UnsupportedFeedDecimals(uint8 decimals);

    constructor(IVoidTwapPoolV6 pool_, IAggregatorV3V6 ethUsdFeed_, uint32 minInterval_, uint32 maxFeedAge_) {
        require(address(pool_) != address(0) && address(ethUsdFeed_) != address(0), "zero address");
        require(minInterval_ > 0 && maxFeedAge_ >= minInterval_, "bad interval");
        pool = pool_;
        ethUsdFeed = ethUsdFeed_;
        minInterval = minInterval_;
        maxFeedAge = maxFeedAge_;
        uint8 decimals_ = ethUsdFeed_.decimals();
        if (decimals_ > 18) revert UnsupportedFeedDecimals(decimals_);
        ethUsdDecimals = decimals_;
    }

    /// @notice Starts the first TWAP window after genesis liquidity exists.
    function bootstrap() external {
        if (lastTimestamp != 0) revert AlreadyBootstrapped();
        (uint256 cumulative, uint32 timestamp) = pool.observe();
        if (cumulative == 0) revert BadCumulative();
        lastCumulative = cumulative;
        lastTimestamp = timestamp;
        emit Bootstrapped(cumulative, timestamp);
    }

    /// @notice Publishes a time-weighted rate after a complete observation
    /// interval. Permissionless so the Paymaster is not dependent on a keeper.
    function update() external returns (uint256 next) {
        uint32 previous = lastTimestamp;
        if (previous == 0) revert NotBootstrapped();
        (uint256 cumulative, uint32 timestamp) = pool.observe();
        uint32 elapsed = timestamp - previous;
        if (elapsed < minInterval) revert IntervalTooShort(elapsed, minInterval);
        if (cumulative < lastCumulative) revert BadCumulative();
        next = (cumulative - lastCumulative) / elapsed;
        if (next == 0) revert BadCumulative();
        lastCumulative = cumulative;
        lastTimestamp = timestamp;
        twapVoidPerEth = next;
        emit Updated(next, elapsed);
    }

    function voidPerEth() external view returns (uint256) {
        return twapVoidPerEth;
    }

    function voidUsd() public view returns (uint256) {
        uint256 rate = twapVoidPerEth;
        if (rate == 0) return 0;
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert BadEthUsdAnswer();
        if (updatedAt == 0 || block.timestamp > updatedAt + maxFeedAge) revert StaleEthUsd(updatedAt);
        uint256 ethUsd18 = uint256(answer) * (10 ** (18 - ethUsdDecimals));
        return Math.mulDiv(ethUsd18, 1e18, rate);
    }

    function usdToVoid(uint256 usdAmount) external view returns (uint256) {
        uint256 rate = twapVoidPerEth;
        if (rate == 0) return 0;
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert BadEthUsdAnswer();
        if (updatedAt == 0 || block.timestamp > updatedAt + maxFeedAge) revert StaleEthUsd(updatedAt);
        uint256 ethUsd18 = uint256(answer) * (10 ** (18 - ethUsdDecimals));
        return Math.mulDiv(usdAmount, rate, ethUsd18);
    }
}
