// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title VoidSwap
/// @notice A constant-product AMM for a pair of tokens.
///
/// @dev    A third-party application running on a VOID Chain. The point of it
///         existing is not to be a competitive DEX — it is to generate real load
///         and prove that an NFT chain runs contracts with state, arithmetic and
///         reentrancy like any EVM.
///
///         It follows x * y = k with a 0.3% fee, the same design as Uniswap V2,
///         because that is the behavior most stress tests expect to reproduce.
contract VoidSwap {
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    /// @notice 30 basis points, the AMM standard.
    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;

    /// @notice Minimum liquidity burned on the first deposit.
    /// @dev    Stops the first provider from withdrawing everything and leaving
    ///         the pool in a state where a fraction of a wei distorts the price.
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event Swap(address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error InsufficientLiquidity();
    error InsufficientOutput();
    error InvalidAmount();
    error TransferFailed();

    constructor(IERC20 token0_, IERC20 token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Deposits both sides and receives pool shares.
    /// @dev    After the first time, it requires a ratio compatible with the
    ///         reserves — otherwise the depositor would be donating value to the
    ///         pool without receiving an equivalent share.
    function addLiquidity(uint256 amount0, uint256 amount1) external returns (uint256 minted) {
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();

        if (!token0.transferFrom(msg.sender, address(this), amount0)) revert TransferFailed();
        if (!token1.transferFrom(msg.sender, address(this), amount1)) revert TransferFailed();

        if (totalShares == 0) {
            minted = _sqrt(amount0 * amount1);
            if (minted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            minted -= MINIMUM_LIQUIDITY;
            totalShares = MINIMUM_LIQUIDITY; // burned forever
        } else {
            uint256 byToken0 = (amount0 * totalShares) / reserve0;
            uint256 byToken1 = (amount1 * totalShares) / reserve1;
            minted = byToken0 < byToken1 ? byToken0 : byToken1;
            if (minted == 0) revert InsufficientLiquidity();
        }

        shares[msg.sender] += minted;
        totalShares += minted;
        reserve0 += amount0;
        reserve1 += amount1;

        emit LiquidityAdded(msg.sender, amount0, amount1, minted);
    }

    function removeLiquidity(uint256 shareAmount)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        if (shareAmount == 0 || shares[msg.sender] < shareAmount) revert InvalidAmount();

        amount0 = (shareAmount * reserve0) / totalShares;
        amount1 = (shareAmount * reserve1) / totalShares;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        // State before the transfers: the same pattern as the protocol treasury.
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        reserve0 -= amount0;
        reserve1 -= amount1;

        if (!token0.transfer(msg.sender, amount0)) revert TransferFailed();
        if (!token1.transfer(msg.sender, amount1)) revert TransferFailed();

        emit LiquidityRemoved(msg.sender, amount0, amount1, shareAmount);
    }

    /// @notice Swaps one token for the other.
    /// @param  zeroForOne true gives token0 and receives token1.
    /// @param  minAmountOut Acceptable floor, so the caller can protect
    ///         themselves from slippage between sending the transaction and it
    ///         executing.
    function swap(bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();
        if (reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();

        (IERC20 tokenIn, IERC20 tokenOut, uint256 reserveIn, uint256 reserveOut) = zeroForOne
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        if (!tokenIn.transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();

        // The fee stays in the pool, raising the value of every share.
        uint256 amountInAfterFee = (amountIn * (BPS - FEE_BPS)) / BPS;
        amountOut = (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);

        if (amountOut < minAmountOut || amountOut == 0) revert InsufficientOutput();

        if (zeroForOne) {
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        if (!tokenOut.transfer(msg.sender, amountOut)) revert TransferFailed();

        emit Swap(msg.sender, zeroForOne, amountIn, amountOut);
    }

    /// @notice How much would come out for a given input, without executing.
    function quote(bool zeroForOne, uint256 amountIn) external view returns (uint256) {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) return 0;
        (uint256 reserveIn, uint256 reserveOut) =
            zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInAfterFee = (amountIn * (BPS - FEE_BPS)) / BPS;
        return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
    }

    /// @notice The pool's invariant. It only grows, never shrinks.
    function k() external view returns (uint256) {
        return reserve0 * reserve1;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
