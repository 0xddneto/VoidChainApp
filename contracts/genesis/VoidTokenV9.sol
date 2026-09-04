// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title VOID V9
/// @notice Fixed-supply VOID with wallet-balance voting and two permanently
///         frozen protocol operators: the Runtime and the Paymaster.
/// @dev Operators do not receive a reusable allowance. They can only move VOID
///      while enforcing the user's one-call EIP-712 authorization in the audited
///      Runtime/Paymaster path. No app is an operator and the list cannot grow.
contract VoidTokenV9 is ERC20, ERC20Permit {
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;
    uint256 public constant DEED_COUNT = 1111;
    uint256 public constant VOID_PER_DEED = 500_000e18;

    address public bootstrapGovernor;
    address public runtimeOperator;
    address public paymasterOperator;
    bool public operatorsFrozen;

    Checkpoints.Trace208 private _supplyHistory;
    mapping(address account => Checkpoints.Trace208) private _balanceHistory;

    error ZeroAddress();
    error NotBootstrapGovernor(address caller);
    error OperatorsAlreadyFrozen();
    error NotProtocolOperator(address caller);
    error SnapshotNotInPast(uint256 blockNumber);

    event OperatorsFrozen(address indexed runtime, address indexed paymaster);

    constructor(address genesisEscrow, address bootstrapGovernor_)
        ERC20("VOID", "VOID")
        ERC20Permit("VOID")
    {
        if (genesisEscrow == address(0) || bootstrapGovernor_ == address(0)) revert ZeroAddress();
        bootstrapGovernor = bootstrapGovernor_;
        _mint(genesisEscrow, MAX_SUPPLY);
    }

    /// @notice One-time deployment wiring. There is deliberately no replacement
    ///         setter, governor escape hatch or proxy-admin path.
    function freezeProtocolOperators(address runtime, address paymaster) external {
        if (msg.sender != bootstrapGovernor) revert NotBootstrapGovernor(msg.sender);
        if (operatorsFrozen) revert OperatorsAlreadyFrozen();
        if (runtime == address(0) || paymaster == address(0)) revert ZeroAddress();
        runtimeOperator = runtime;
        paymasterOperator = paymaster;
        operatorsFrozen = true;
        bootstrapGovernor = address(0);
        emit OperatorsFrozen(runtime, paymaster);
    }

    /// @notice Moves VOID only for the frozen protocol execution path.
    /// @dev The caller, not this token, validates the user's signed per-call
    ///      amount and nonce. This function never authorizes a ChainApp directly.
    function protocolTransferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (!operatorsFrozen || (msg.sender != runtimeOperator && msg.sender != paymasterOperator)) {
            revert NotProtocolOperator(msg.sender);
        }
        _transfer(from, to, amount);
        return true;
    }

    function isProtocolOperator(address account) external view returns (bool) {
        return operatorsFrozen && (account == runtimeOperator || account == paymasterOperator);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
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
