// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidGenesisEscrowV10} from "./VoidGenesisEscrowV10.sol";

/// @notice Canonical V11 escrow used for the one-time V10 state import.
contract VoidGenesisEscrowV11 is VoidGenesisEscrowV10 {
    constructor(address bootstrapGovernor) VoidGenesisEscrowV10(bootstrapGovernor) {}
}
