// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidChainAppRuntimeV5} from "./VoidChainAppRuntimeV5.sol";
import {IVoidChainDeed, IERC20, IVoidChainTreasury} from "./VoidChainAppRuntime.sol";

/// @title VoidChainAppRuntimeV6
/// @notice V5 execution boundary with constructor-only import of testnet accounting.
/// @dev There is no migration setter: after construction, the imported revenue
///      and transaction counters are governed by the same runtime rules as new state.
contract VoidChainAppRuntimeV6 is VoidChainAppRuntimeV5 {
    struct ImportedChain {
        uint256 tokenId;
        bool active;
        uint256 feePerCallUsd;
        bool permissionlessDeploy;
        uint256 pending;
        address pendingOwner;
        uint256 lifetimeRevenue;
        uint256 callCount;
    }

    uint256 public immutable importedLiability;

    error InvalidImportedChain(uint256 tokenId);
    error InvalidImportedPendingOwner(uint256 tokenId);

    constructor(
        IVoidChainDeed deed_,
        IERC20 feeToken_,
        IVoidChainTreasury treasury_,
        ImportedChain[] memory imported,
        uint256 importedProtocolAccrued
    ) VoidChainAppRuntimeV5(deed_, feeToken_, treasury_) {
        uint256 liability = importedProtocolAccrued;
        protocolAccrued = importedProtocolAccrued;
        for (uint256 i; i < imported.length; ++i) {
            ImportedChain memory item = imported[i];
            if (item.tokenId == 0 || item.tokenId > 1111 || configured[item.tokenId]) {
                revert InvalidImportedChain(item.tokenId);
            }
            if (item.pending != 0 && item.pendingOwner == address(0)) {
                revert InvalidImportedPendingOwner(item.tokenId);
            }
            configured[item.tokenId] = true;
            apps[item.tokenId] = ChainApp({
                active: item.active,
                feePerCallUsd: item.feePerCallUsd,
                permissionlessDeploy: item.permissionlessDeploy,
                pending: item.pending,
                pendingOwner: item.pendingOwner,
                lifetimeRevenue: item.lifetimeRevenue,
                callCount: item.callCount
            });
            liability += item.pending;
        }
        importedLiability = liability;
    }
}
