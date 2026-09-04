// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VoidGenesisEscrowV6, IVoidEscrowToken} from "./VoidGenesisEscrowV6.sol";

/// @title VoidGenesisEscrowV10
/// @notice Fixed-supply escrow with a one-time, fully accounted testnet-state import.
/// @dev The imported balances must equal the already-consumed LP and NFT-AMM
///      buckets. This preserves the 1B supply without duplicating circulating VOID.
contract VoidGenesisEscrowV10 is VoidGenesisEscrowV6 {
    struct MigrationConfig {
        IVoidEscrowToken token;
        address launch;
        address liquidityPool;
        address builderVault;
        address protocolVault;
        uint256 lpAlreadyReleased;
        uint256 nftAlreadyReleased;
    }

    bool public migrationConfigured;

    event MigrationConfigured(uint256 lpAlreadyReleased, uint256 nftAlreadyReleased, uint256 recipients);

    error LengthMismatch();
    error InvalidMigrationAccounting(uint256 distributed, uint256 expected);
    error InvalidMigratedDeed(uint256 deedId);

    constructor(address governor_) VoidGenesisEscrowV6(governor_) {}

    function configureMigrationOnce(
        MigrationConfig calldata config,
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256[] calldata migratedNftDeedIds
    ) external {
        if (msg.sender != bootstrapGovernor) revert NotBootstrapGovernor(msg.sender);
        if (configured || migrationConfigured) revert AlreadyConfigured();
        if (recipients.length != amounts.length) revert LengthMismatch();
        if (config.lpAlreadyReleased > LP_CAP || config.nftAlreadyReleased > NFT_AMM_CAP) {
            revert CapExceeded(config.lpAlreadyReleased + config.nftAlreadyReleased, LP_CAP + NFT_AMM_CAP);
        }
        if (migratedNftDeedIds.length * 500_000e18 != config.nftAlreadyReleased) {
            revert InvalidMigrationAccounting(migratedNftDeedIds.length * 500_000e18, config.nftAlreadyReleased);
        }
        if (
            address(config.token) == address(0) || config.launch == address(0) || config.liquidityPool == address(0)
                || config.builderVault == address(0) || config.protocolVault == address(0)
        ) revert ZeroAddress();
        if (config.token.balanceOf(address(this)) != TOTAL_SUPPLY) {
            revert BadSupply(config.token.balanceOf(address(this)));
        }

        uint256 distributed;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroAddress();
            distributed += amounts[i];
        }
        uint256 expected = config.lpAlreadyReleased + config.nftAlreadyReleased;
        if (distributed != expected) revert InvalidMigrationAccounting(distributed, expected);

        token = config.token;
        launch = config.launch;
        liquidityPool = config.liquidityPool;
        lpReleased = config.lpAlreadyReleased;
        nftAmmReleased = config.nftAlreadyReleased;
        configured = true;
        migrationConfigured = true;

        if (!config.token.transfer(config.builderVault, BUILDER_CAP)) revert TransferFailed();
        if (!config.token.transfer(config.protocolVault, PROTOCOL_CAP)) revert TransferFailed();
        for (uint256 i; i < recipients.length; ++i) {
            if (amounts[i] != 0 && !config.token.transfer(recipients[i], amounts[i])) revert TransferFailed();
        }
        for (uint256 i; i < migratedNftDeedIds.length; ++i) {
            uint256 deedId = migratedNftDeedIds[i];
            if (deedId == 0 || deedId > 1111 || deedReleased[deedId]) revert InvalidMigratedDeed(deedId);
            deedReleased[deedId] = true;
        }

        emit Configured(address(config.token), config.launch, config.liquidityPool);
        emit MigrationConfigured(config.lpAlreadyReleased, config.nftAlreadyReleased, recipients.length);
    }
}
