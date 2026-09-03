// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";
import {VoidUniswapV2Pair} from "./VoidUniswapV2Pair.sol";

/// @notice V4's permissionless app publisher. The gateway it creates makes an
/// app callable only from the immutable Runtime.
interface IVoidChainAppFactoryV4 {
    function publish(uint256 tokenId, address implementation, bytes calldata initialiseData, bytes32 salt)
        external returns (address app);
}

/// @title VoidChainDexFactoryV4
/// @notice Uniswap V2-style pair factory published through the V4 gateway.
/// @dev Derived architecture from Uniswap V2's permissionless pair factory.
///      Both the factory and every pair are gateway apps, so neither has a
///      direct wallet transaction entry point. User actions enter only via the
///      Runtime and VoidPaymaster and are billed in the chain's VOID fee.
contract VoidChainDexFactoryV4 is ChainAppBase {
    IVoidChainAppFactoryV4 public immutable appFactory;

    mapping(address tokenA => mapping(address tokenB => address pool)) public poolFor;
    address[] public allPools;

    event PoolCreated(address indexed token0, address indexed token1, address indexed pool, address creator);

    error IdenticalTokens();
    error PoolAlreadyExists(address token0, address token1);
    error InvalidAppFactory();

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_, IVoidChainAppFactoryV4 appFactory_)
        ChainAppBase(runtime_, chainId_)
    {
        if (address(appFactory_) == address(0)) revert InvalidAppFactory();
        appFactory = appFactory_;
    }

    /// @notice Permissionlessly creates a 50/50 constant-product pool.
    /// @dev This function is a ChainApp action, so the publisher signs a VOID
    ///      sponsored request. The factory deploys a pair implementation, then
    ///      publishes its guarded gateway in the same execution.
    function createPool(address tokenA, address tokenB) external onlyFromMyChain returns (address pool) {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (poolFor[token0][token1] != address(0)) revert PoolAlreadyExists(token0, token1);

        address implementation = address(new VoidUniswapV2Pair(runtime, chainId, token0, token1));
        pool = appFactory.publish(
            chainId,
            implementation,
            abi.encodeWithSelector(VoidUniswapV2Pair.initialize.selector),
            keccak256(abi.encode(token0, token1))
        );
        poolFor[token0][token1] = pool;
        poolFor[token1][token0] = pool;
        allPools.push(pool);
        emit PoolCreated(token0, token1, pool, caller());
    }

    function poolsLength() external view returns (uint256) { return allPools.length; }
}
