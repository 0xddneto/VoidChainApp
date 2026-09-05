// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidGovernanceVotesV9, IVoidHistoricalVotesV9} from "./VoidGovernanceVotesV9.sol";

/// @notice Canonical V11 circulating-supply voting adapter.
contract VoidGovernanceVotesV11 is VoidGovernanceVotesV9 {
    constructor(IVoidHistoricalVotesV9 token, address[] memory excluded)
        VoidGovernanceVotesV9(token, excluded)
    {}
}
