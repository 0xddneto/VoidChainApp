// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidChainAppRuntimeV4} from "./VoidChainAppRuntimeV4.sol";
import {IVoidChainDeed, IERC20, IVoidChainTreasury} from "./VoidChainAppRuntime.sol";

/// @title VoidChainAppRuntimeV5
/// @notice Security-versioned runtime whose oracle, forwarder, DAO factory and
///         application factory are all one-time deployment decisions.
contract VoidChainAppRuntimeV5 is VoidChainAppRuntimeV4 {
    constructor(IVoidChainDeed deed_, IERC20 feeToken_, IVoidChainTreasury treasury_)
        VoidChainAppRuntimeV4(deed_, feeToken_, treasury_)
    {}
}
