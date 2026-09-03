// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidChainAppRuntimeV3} from "./VoidChainAppRuntimeV3.sol";
import {IVoidChainDeed, IERC20, IVoidChainTreasury} from "./VoidChainAppRuntime.sol";

/// @title VoidChainAppRuntimeV4
/// @notice Same immutable execution boundary as V3, paired with the audited
/// gateway factory that exposes static, read-only app queries.
contract VoidChainAppRuntimeV4 is VoidChainAppRuntimeV3 {
    constructor(IVoidChainDeed deed_, IERC20 feeToken_, IVoidChainTreasury treasury_)
        VoidChainAppRuntimeV3(deed_, feeToken_, treasury_)
    {}
}
