// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidTwapSourceV6 {
    function voidPerEth() external view returns (uint256);
    function voidUsd() external view returns (uint256);
    function usdToVoid(uint256 usdAmount) external view returns (uint256);
    function lastTimestamp() external view returns (uint32);
}

/// @title VoidTwapFreshnessGuardV6
/// @notice Refuses to expose a TWAP after its published observation has aged.
/// @dev The underlying TWAP deliberately has a permissionless `update`; this
/// small immutable guard makes missing keepers fail closed at the Runtime and
/// Paymaster instead of silently charging from an old pool price.
contract VoidTwapFreshnessGuardV6 {
    IVoidTwapSourceV6 public immutable source;
    uint32 public immutable maxAge;

    error StaleTwap(uint32 updatedAt, uint32 maxAge);
    error ZeroAddress();

    constructor(IVoidTwapSourceV6 source_, uint32 maxAge_) {
        if (address(source_) == address(0) || maxAge_ == 0) revert ZeroAddress();
        source = source_;
        maxAge = maxAge_;
    }

    function voidPerEth() external view returns (uint256) {
        _requireFresh();
        return source.voidPerEth();
    }

    function voidUsd() external view returns (uint256) {
        _requireFresh();
        return source.voidUsd();
    }

    function usdToVoid(uint256 usdAmount) external view returns (uint256) {
        _requireFresh();
        return source.usdToVoid(usdAmount);
    }

    function _requireFresh() private view {
        uint32 updatedAt = source.lastTimestamp();
        if (updatedAt == 0 || block.timestamp > uint256(updatedAt) + maxAge) {
            revert StaleTwap(updatedAt, maxAge);
        }
    }
}
