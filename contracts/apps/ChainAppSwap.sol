// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title ChainAppSwap
/// @notice The same DEX as `VoidSwap`, living inside a chainapp.
///
/// @dev    It exists for an honest comparison. Both do exactly the same
///         arithmetic — x*y=k, a 0.3% fee, the same formula — so that the
///         measured difference between chainapp and L3 is only the difference in
///         environment, and not in implementation.
///
///         The ONLY changes relative to VoidSwap:
///
///           1. it inherits `ChainAppBase`, which makes it reachable only
///              through its chain's runtime (that is what makes the toll
///              mandatory);
///           2. it uses `caller()` in place of `msg.sender`, because msg.sender
///              here is always the runtime.
///
///         Nothing else. If the comparison shows a cost difference, it comes
///         from the environment, which is what is on trial.
contract ChainAppSwap is ChainAppBase, ReentrancyGuard {
    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    uint256 public totalShares;
    mapping(address => uint256) public shares;

    uint256 public constant FEE_BPS = 30;
    uint256 public constant BPS = 10_000;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 sharesBurned);
    event Swap(address indexed trader, bool zeroForOne, uint256 amountIn, uint256 amountOut);

    error InsufficientLiquidity();
    error InsufficientOutput();
    error InvalidAmount();
    error TransferFailed();

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_, IERC20 t0, IERC20 t1)
        ChainAppBase(runtime_, chainId_)
    {
        token0 = t0;
        token1 = t1;
    }

    /// @param  minShares The minimum shares the provider accepts receiving.
    ///
    /// @dev    THIS PARAMETER WAS MISSING, and its absence was found in red-team.
    ///
    ///         `swap` already protects itself from slippage with `minAmountOut`,
    ///         but `addLiquidity` accepted any ratio with no floor. Whoever
    ///         deposits into a pool whose price has just been moved — by the
    ///         chain owner, who orders the block, or by a front-runner —
    ///         receives fewer shares than the value they handed over, and the
    ///         excess is socialized into the reserves. Measured: up to 28.6% loss
    ///         in a skewed pool.
    ///
    ///         The floor makes the loss the provider's decision rather than an
    ///         ambush: a ratio worse than the one accepted reverts the
    ///         transaction.
    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minShares)
        external
        onlyFromMyChain
        nonReentrant
        returns (uint256 minted)
    {
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();
        address who = caller();

        spend(address(token0), address(this), amount0);
        spend(address(token1), address(this), amount1);

        if (totalShares == 0) {
            minted = _sqrt(amount0 * amount1);
            if (minted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            minted -= MINIMUM_LIQUIDITY;
            totalShares = MINIMUM_LIQUIDITY;
        } else {
            uint256 byToken0 = (amount0 * totalShares) / reserve0;
            uint256 byToken1 = (amount1 * totalShares) / reserve1;
            minted = byToken0 < byToken1 ? byToken0 : byToken1;
            if (minted == 0) revert InsufficientLiquidity();
        }

        if (minted < minShares) revert InsufficientOutput();

        shares[who] += minted;
        totalShares += minted;
        reserve0 += amount0;
        reserve1 += amount1;

        emit LiquidityAdded(who, amount0, amount1, minted);
    }

    /// @notice Returns the liquidity and redeems the accrued share of fees.
    ///
    /// @dev    THE ABSENCE OF THIS WAS A DEFECT, found in red-team.
    ///
    ///         The contract recorded `shares` in `addLiquidity` but had no exit
    ///         path — anyone providing liquidity lost their tokens forever, and
    ///         the documentation claimed (falsely) that this DEX was identical to
    ///         VoidSwap, which has the redemption. Without this function, the
    ///         first good-faith provider drawn in by "earning fees" would lose
    ///         everything.
    ///
    ///         It comes from VoidSwap, adapted for the runtime: the share
    ///         belongs to `caller()`, not to `msg.sender` (which here is always
    ///         the runtime), and the entry point is `onlyFromMyChain` like
    ///         everything else.
    function removeLiquidity(uint256 shareAmount)
        external
        onlyFromMyChain
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        address who = caller();
        if (shareAmount == 0 || shares[who] < shareAmount) revert InvalidAmount();

        amount0 = (shareAmount * reserve0) / totalShares;
        amount1 = (shareAmount * reserve1) / totalShares;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        // State before the transfers — checks-effects-interactions.
        shares[who] -= shareAmount;
        totalShares -= shareAmount;
        reserve0 -= amount0;
        reserve1 -= amount1;

        if (!token0.transfer(who, amount0)) revert TransferFailed();
        if (!token1.transfer(who, amount1)) revert TransferFailed();

        emit LiquidityRemoved(who, amount0, amount1, shareAmount);
    }

    function swap(bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external
        onlyFromMyChain
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InvalidAmount();
        if (reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();

        address who = caller();
        (IERC20 tokenIn, IERC20 tokenOut, uint256 reserveIn, uint256 reserveOut) = zeroForOne
            ? (token0, token1, reserve0, reserve1)
            : (token1, token0, reserve1, reserve0);

        spend(address(tokenIn), address(this), amountIn);

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

        if (!tokenOut.transfer(who, amountOut)) revert TransferFailed();

        emit Swap(who, zeroForOne, amountIn, amountOut);
    }

    function quote(bool zeroForOne, uint256 amountIn) external view returns (uint256) {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) return 0;
        (uint256 reserveIn, uint256 reserveOut) =
            zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInAfterFee = (amountIn * (BPS - FEE_BPS)) / BPS;
        return (amountInAfterFee * reserveOut) / (reserveIn + amountInAfterFee);
    }

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
