// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    VoidEthGenesisMintV10,
    IVoidGenesisDeedV6,
    IVoidGenesisEscrowV6,
    IVoidEthPoolV6
} from "./VoidEthGenesisMintV10.sol";

/// @notice Canonical V11 ETH mint that resumes the existing six-Deed ledger.
contract VoidEthGenesisMintV11 is VoidEthGenesisMintV10 {
    constructor(
        IVoidGenesisDeedV6 deed,
        IVoidGenesisEscrowV6 escrow,
        IVoidEthPoolV6 pool,
        address payable paymaster,
        address payable protocolTreasury,
        uint256 price,
        address[] memory holders,
        uint256 migrationVoidLiquidity,
        uint256 migrationEthLiquidity
    ) VoidEthGenesisMintV10(
        deed,
        escrow,
        pool,
        paymaster,
        protocolTreasury,
        price,
        holders,
        migrationVoidLiquidity,
        migrationEthLiquidity
    ) {}
}
