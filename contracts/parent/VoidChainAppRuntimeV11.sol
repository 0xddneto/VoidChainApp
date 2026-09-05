// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidChainAppRuntimeV6} from "./VoidChainAppRuntimeV6.sol";
import {IVoidChainDeed, IERC20, IVoidChainTreasury} from "./VoidChainAppRuntime.sol";

/// @notice Canonical V11 Runtime with constructor-only V10 ledger import.
contract VoidChainAppRuntimeV11 is VoidChainAppRuntimeV6 {
    constructor(
        IVoidChainDeed deed,
        IERC20 feeToken,
        IVoidChainTreasury treasury,
        ImportedChain[] memory imported,
        uint256 importedProtocolAccrued
    ) VoidChainAppRuntimeV6(deed, feeToken, treasury, imported, importedProtocolAccrued) {}
}
