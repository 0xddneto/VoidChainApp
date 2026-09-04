// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidEthGenesisMintV7, IVoidGenesisDeedV6, IVoidGenesisEscrowV6, IVoidEthPoolV6}
    from "./VoidEthGenesisMintV7.sol";

/// @title VoidEthGenesisMintV8
/// @notice Version marker for the security migration to the oracle-frozen V5 runtime.
contract VoidEthGenesisMintV8 is VoidEthGenesisMintV7 {
    constructor(
        IVoidGenesisDeedV6 deed_,
        IVoidGenesisEscrowV6 escrow_,
        IVoidEthPoolV6 pool_,
        address payable paymaster_,
        address payable protocolTreasury_,
        uint256 price_,
        address[] memory holders
    ) VoidEthGenesisMintV7(deed_, escrow_, pool_, paymaster_, protocolTreasury_, price_, holders) {}
}
