// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Chainlink's feed, in its standard shape.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @notice The minimum of a Uniswap V3 pool needed to read a TWAP.
/// @dev    `observe` returns the tick accumulators; the difference between two
///         points in time, divided by the interval, is the window's mean tick.
interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityX128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title VoidPriceOracle
/// @notice The price of VOID in dollars, composed from two sources that exist.
///
/// @dev    WHY COMPOSE, INSTEAD OF READING A SINGLE FEED.
///
///         There is no VOID/USD feed, and there will not be one any time soon:
///         Chainlink only creates a feed for an asset with a real market across
///         several exchanges, and VOID trades in a single pool. What does exist
///         is:
///
///           ETH/USD   — Chainlink, on Robinhood Chain, ready
///           VOID/ETH  — our pool, which we created ourselves
///
///         Multiplied, they give VOID/USD. Nothing magic: the oracle does not
///         "know" the price of VOID, it derives it from a price somebody
///         trustworthy publishes and a ratio our own market forms.
///
///         WHY A TWAP, AND NOT THE PRICE RIGHT NOW.
///
///         The pool is OURS — shallow at first, and therefore cheap to push.
///         With a spot price, an attacker buys VOID in the same transaction,
///         pushes the quote, reads the inflated number, and unwinds. It costs
///         almost nothing and lies to the contract.
///
///         A TWAP forces them to hold the distortion for the whole window,
///         genuinely spending the entire time and being arbitraged by everyone
///         while they do. It does not make manipulation impossible — it makes it
///         expensive, which is the most a pool oracle can offer.
///
///         The 30-minute window is the one the industry uses, and it is a
///         balance: shorter reacts faster but is cheap to push; longer is robust
///         but lags behind a real crash.
contract VoidPriceOracle {
    IAggregatorV3 public immutable ethUsdFeed;
    IUniswapV3Pool public immutable voidEthPool;

    /// @notice Whether VOID is the pool's token0. Decides the direction of the ratio.
    bool public immutable voidIsToken0;

    /// @notice TWAP window, in seconds. 30 minutes, the industry default.
    uint32 public constant TWAP_WINDOW = 1800;

    /// @notice Past this, the Chainlink price is considered stale.
    /// @dev    A stalled feed is worse than no feed: it answers, confidently,
    ///         with a number that no longer holds. We would rather revert than
    ///         operate blind.
    uint256 public constant MAX_FEED_AGE = 3600;

    error StaleFeed(uint256 updatedAt, uint256 nowTs);
    error BadFeedAnswer(int256 answer);
    error PoolNotReady();

    constructor(IAggregatorV3 ethUsdFeed_, IUniswapV3Pool voidEthPool_, address voidToken) {
        ethUsdFeed = ethUsdFeed_;
        voidEthPool = voidEthPool_;
        voidIsToken0 = voidEthPool_.token0() == voidToken;
    }

    // ---------------------------------------------------------------------
    // The two sources
    // ---------------------------------------------------------------------

    /// @notice How much one ETH is worth in dollars, with 18 decimals.
    function ethUsd() public view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert BadFeedAnswer(answer);
        if (block.timestamp > updatedAt + MAX_FEED_AGE) {
            revert StaleFeed(updatedAt, block.timestamp);
        }
        // Chainlink's feed normally has 8 decimals; we normalize to 18.
        uint8 d = ethUsdFeed.decimals();
        return uint256(answer) * (10 ** (18 - d));
    }

    /// @notice How many VOID one ETH is worth, with 18 decimals. The paymaster's rate.
    /// @dev    The window's mean, never the spot price. See the contract comment
    ///         for why.
    function voidPerEth() public view returns (uint256) {
        int24 tick = _twapTick();
        // A Uniswap V3 tick encodes the token1/token0 ratio as 1.0001^tick. We
        // convert with the same square-root-of-price arithmetic as the official
        // library, without depending on it: 1.0001^(tick/2) in Q64.96.
        uint256 ratio = _ratioX128(tick);
        // `ratio` is token1 per token0, in Q128. We invert if VOID is token1.
        return voidIsToken0 ? (1 << 128) * 1e18 / ratio : ratio * 1e18 >> 128;
    }

    /// @notice How much one VOID is worth in dollars, with 18 decimals.
    function voidUsd() public view returns (uint256) {
        uint256 perEth = voidPerEth();
        if (perEth == 0) revert PoolNotReady();
        return (ethUsd() * 1e18) / perEth;
    }

    // ---------------------------------------------------------------------
    // What the contracts consume
    // ---------------------------------------------------------------------

    /// @notice Converts a dollar amount (18 decimals) into VOID.
    /// @dev    This is what turns "the toll is $0.001" into an amount of VOID at
    ///         the moment of the call. With the toll fixed in VOID, a 10x
    ///         appreciation multiplied the real cost of using the chain by ten
    ///         without anyone having decided anything.
    function usdToVoid(uint256 usdAmount) external view returns (uint256) {
        uint256 price = voidUsd();
        if (price == 0) revert PoolNotReady();
        return (usdAmount * 1e18) / price;
    }

    // ---------------------------------------------------------------------
    // TWAP arithmetic
    // ---------------------------------------------------------------------

    function _twapTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;

        (int56[] memory cumulatives,) = voidEthPool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];

        int24 tick = int24(delta / int56(uint56(TWAP_WINDOW)));
        // Integer division truncates toward zero; for negatives that rounds UP,
        // which would bias the price. We correct downward.
        if (delta < 0 && (delta % int56(uint56(TWAP_WINDOW)) != 0)) tick--;
        return tick;
    }

    /// @dev token1/token0 ratio in Q128, from the tick. Binary exponentiation
    ///      over 1.0001 — the same idea as Uniswap's `TickMath`, written here so
    ///      the contract does not depend on an entire external library.
    function _ratioX128(int24 tick) internal pure returns (uint256) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));

        uint256 r = 0x100000000000000000000000000000000; // 1.0 in Q128
        uint256 base = 0x1000276a3000000000000000000000000; // 1.0001 in Q128

        while (absTick > 0) {
            if (absTick & 1 != 0) r = (r * base) >> 128;
            base = (base * base) >> 128;
            absTick >>= 1;
        }

        if (tick < 0) r = type(uint256).max / r;
        return r;
    }
}
