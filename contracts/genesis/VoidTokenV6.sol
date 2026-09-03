// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title VoidTokenV6
/// @notice Official fixed-supply VOID token for the reviewed testnet genesis.
/// @dev Voting power is the wallet's historical balance. It is deliberately
/// not delegated and never locked: a holder votes with the VOID they hold.
contract VoidTokenV6 is ERC20, ERC20Permit {
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant DEED_COUNT = 1111;
    uint256 public constant VOID_PER_DEED = 500_000e18;

    Checkpoints.Trace208 private _supplyHistory;
    mapping(address account => Checkpoints.Trace208) private _balanceHistory;

    error ZeroAddress();
    error SnapshotNotInPast(uint256 blockNumber);

    /// @param genesisEscrow Receives 100% of supply. There is no mint function
    /// after this constructor, and it cannot change the maximum supply.
    constructor(address genesisEscrow) ERC20("VOID", "VOID") ERC20Permit("VOID") {
        if (genesisEscrow == address(0)) revert ZeroAddress();
        _mint(genesisEscrow, MAX_SUPPLY);
    }

    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _balanceHistory[account].upperLookupRecent(blockNumber.toUint48());
    }

    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256) {
        if (blockNumber >= block.number) revert SnapshotNotInPast(blockNumber);
        return _supplyHistory.upperLookupRecent(blockNumber.toUint48());
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0)) _writeCheckpoint(from);
        if (to != address(0)) _writeCheckpoint(to);
        _supplyHistory.push(block.number.toUint48(), totalSupply().toUint208());
    }

    function _writeCheckpoint(address account) private {
        _balanceHistory[account].push(block.number.toUint48(), balanceOf(account).toUint208());
    }
}
