// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidTokenV9} from "./VoidTokenV9.sol";

/// @notice Canonical V11 fixed-supply VOID token.
/// @dev The V11 type freezes the audited V9 token mechanics under the public
///      release name used by the migration and explorer verification.
contract VoidTokenV11 is VoidTokenV9 {
    constructor(address genesisEscrow, address bootstrapGovernor)
        VoidTokenV9(genesisEscrow, bootstrapGovernor)
    {}
}
