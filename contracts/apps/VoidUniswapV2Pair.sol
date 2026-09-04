// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

interface IVoidUniswapToken {
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title VoidUniswapV2Pair
/// @notice Uniswap V2 style 50/50 constant-product pair adapted to a VOID Chain.
/// @dev Derived from the Uniswap v2-core pair design (GPL-3.0-only): standard
///      0.30% invariant, LP ERC-20 balances, cumulative prices, Mint/Burn/Swap
///      events and MINIMUM_LIQUIDITY. The only deliberate adaptation is that
///      deposits are pulled through the chain runtime's one-call budget so a
///      DEX user can authorize an exact amount rather than an unlimited pair
///      approval. See docs/UNISWAP_V2_FORK_NOTICE.md.
contract VoidUniswapV2Pair is ChainAppBase {
    string public constant name = "VOID Uniswap V2 LP";
    string public constant symbol = "V2-LP";
    uint8 public constant decimals = 18;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 private constant FEE_NUMERATOR = 997;
    uint256 private constant FEE_DENOMINATOR = 1_000;

    address public immutable token0;
    address public immutable token1;
    uint112 public reserve0;
    uint112 public reserve1;
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 private unlocked = 1;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);

    error Locked();
    error InvalidAmount();
    error InsufficientLiquidity();
    error InsufficientOutput();
    error Slippage();
    error TransferFailed();
    error AlreadyInitialised();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_, address token0_, address token1_)
        ChainAppBase(runtime_, chainId_)
    {
        if (token0_ == address(0) || token1_ == address(0) || token0_ == token1_) revert ZeroAddress();
        token0 = token0_;
        token1 = token1_;
    }

    /// @notice Initializes the gateway's reentrancy slot during publication.
    /// @dev Constructors initialize implementation storage, while V4 apps run
    /// through delegatecall and keep state in a fresh gateway. The immutable
    /// token/runtime values are already in the implementation code; this is
    /// the one mutable slot that must be initialized in the gateway itself.
    function initialize() external {
        if (unlocked != 0) revert AlreadyInitialised();
        unlocked = 1;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InvalidAmount();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Adds exact assets through the runtime, then mints transferable LP tokens.
    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLiquidity)
        external onlyFromMyChain lock returns (uint256 liquidity)
    {
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();
        spend(token0, address(this), amount0);
        spend(token1, address(this), amount1);

        if (totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            _mint(address(0), MINIMUM_LIQUIDITY);
            liquidity -= MINIMUM_LIQUIDITY;
        } else {
            liquidity = _min((amount0 * totalSupply) / reserve0, (amount1 * totalSupply) / reserve1);
            if (liquidity == 0) revert InsufficientLiquidity();
        }
        if (liquidity < minLiquidity) revert Slippage();
        _mint(caller(), liquidity);
        _update(uint256(reserve0) + amount0, uint256(reserve1) + amount1);
        emit Mint(caller(), amount0, amount1);
    }

    /// @notice Burns caller LP tokens and returns the proportional pool assets.
    function removeLiquidity(uint256 liquidity, uint256 min0, uint256 min1)
        external onlyFromMyChain lock returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0 || balanceOf[caller()] < liquidity) revert InvalidAmount();
        amount0 = (liquidity * reserve0) / totalSupply;
        amount1 = (liquidity * reserve1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();
        if (amount0 < min0 || amount1 < min1) revert Slippage();
        _burn(caller(), liquidity);
        uint256 next0 = uint256(reserve0) - amount0;
        uint256 next1 = uint256(reserve1) - amount1;
        _safeTransfer(token0, caller(), amount0);
        _safeTransfer(token1, caller(), amount1);
        _update(next0, next1);
        emit Burn(caller(), amount0, amount1, caller());
    }

    /// @notice Uniswap V2's 0.30% invariant with an exact input pulled by runtime budget.
    function swap(bool zeroForOne, uint256 amountIn, uint256 minAmountOut)
        external onlyFromMyChain lock returns (uint256 amountOut)
    {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) revert InsufficientLiquidity();
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        amountOut = quote(zeroForOne, amountIn);
        if (amountOut == 0 || amountOut < minAmountOut || amountOut >= reserveOut) revert InsufficientOutput();

        spend(zeroForOne ? token0 : token1, address(this), amountIn);
        _safeTransfer(zeroForOne ? token1 : token0, caller(), amountOut);
        uint256 next0 = zeroForOne ? uint256(reserve0) + amountIn : uint256(reserve0) - amountOut;
        uint256 next1 = zeroForOne ? uint256(reserve1) - amountOut : uint256(reserve1) + amountIn;
        _update(next0, next1);
        emit Swap(caller(), zeroForOne ? amountIn : 0, zeroForOne ? 0 : amountIn, zeroForOne ? 0 : amountOut, zeroForOne ? amountOut : 0, caller());
    }

    function quote(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0 || reserve0 == 0 || reserve1 == 0) return 0;
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    function k() external view returns (uint256) { return uint256(reserve0) * reserve1; }

    function _update(uint256 balance0, uint256 balance1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert InsufficientLiquidity();
        uint32 now32 = uint32(block.timestamp);
        uint32 elapsed;
        unchecked { elapsed = now32 - blockTimestampLast; }
        if (elapsed > 0 && reserve0 != 0 && reserve1 != 0) {
            price0CumulativeLast += ((uint256(reserve1) << 112) / reserve0) * elapsed;
            price1CumulativeLast += ((uint256(reserve0) << 112) / reserve1) * elapsed;
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = now32;
        emit Sync(reserve0, reserve1);
    }

    function _mint(address to, uint256 value) private { totalSupply += value; balanceOf[to] += value; emit Transfer(address(0), to, value); }
    function _burn(address from, uint256 value) private { balanceOf[from] -= value; totalSupply -= value; emit Transfer(from, address(0), value); }
    function _transfer(address from, address to, uint256 value) private { if (balanceOf[from] < value) revert InvalidAmount(); balanceOf[from] -= value; balanceOf[to] += value; emit Transfer(from, to, value); }
    function _safeTransfer(address token, address to, uint256 value) private { if (!IVoidUniswapToken(token).transfer(to, value)) revert TransferFailed(); }
    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }
    function _sqrt(uint256 value) private pure returns (uint256 y) { if (value == 0) return 0; uint256 z = (value + 1) / 2; y = value; while (z < y) { y = z; z = (value / z + z) / 2; } }
}
