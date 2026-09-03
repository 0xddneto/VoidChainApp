// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";
import {ChainAppSwap, IERC20 as ISwapToken} from "./ChainAppSwap.sol";

interface IAppRegistry is IVoidChainAppRuntime {
    function registerApp(uint256 tokenId, address app) external;
}

/// @title VoidChainDexFactory
/// @notice Creates and registers constant-product pools for one VOID Chain.
/// @dev The factory is itself a chain app. A pool can therefore only be created
///      through the chain runtime and pays that chain's transaction fee. Each
///      pair it creates has the same immutable runtime and tokenId, so neither
///      a factory call nor a pool can be reused on another VOID Chain.
contract VoidChainDexFactory is ChainAppBase {
    mapping(address tokenA => mapping(address tokenB => address pool)) public poolFor;
    address[] public allPools;

    event PoolCreated(
        address indexed token0,
        address indexed token1,
        address indexed pool,
        address creator
    );

    error IdenticalTokens();
    error PoolAlreadyExists(address token0, address token1);

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_)
        ChainAppBase(runtime_, chainId_)
    {}

    /// @notice Creates a pool once for an unordered pair and publishes it to
    ///         this chain in the same transaction.
    function createPool(address tokenA, address tokenB)
        external
        onlyFromMyChain
        returns (address pool)
    {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (tokenA == tokenB) revert IdenticalTokens();

        (address token0, address token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);
        if (poolFor[token0][token1] != address(0)) {
            revert PoolAlreadyExists(token0, token1);
        }

        pool = address(new ChainAppSwap(runtime, chainId, ISwapToken(token0), ISwapToken(token1)));
        poolFor[token0][token1] = pool;
        poolFor[token1][token0] = pool;
        allPools.push(pool);

        // The runtime authenticates the new pool's immutable runtime and chain
        // identity before registering it. The registry is open for this test
        // chain, so the factory may publish the pool it has just created.
        IAppRegistry(address(runtime)).registerApp(chainId, pool);
        emit PoolCreated(token0, token1, pool, caller());
    }

    function poolsLength() external view returns (uint256) {
        return allPools.length;
    }
}
