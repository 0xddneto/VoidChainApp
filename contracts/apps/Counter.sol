// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ChainAppBase, IVoidChainAppRuntime} from "./ChainAppBase.sol";

/// @title Counter
/// @notice The simplest possible application of a chainapp.
///
/// @dev    It exists for the scale test. When you want to measure the RUNTIME
///         under hundreds of simultaneous chains, the application has to be
///         cheap and predictable — a DEX in there would mix the cost of its own
///         arithmetic with the cost of the system, and there would be no way to
///         tell which of the two is being measured.
///
///         The counter serves a second purpose: it records, from INSIDE the
///         chain, how many times it was used. Comparing that number with what
///         the runtime accounted for is what detects a call that executed
///         without paying, or a toll charged without an execution.
contract Counter is ChainAppBase {
    uint256 public count;

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_)
        ChainAppBase(runtime_, chainId_)
    {}

    function bump() external onlyFromMyChain {
        count += 1;
    }
}
