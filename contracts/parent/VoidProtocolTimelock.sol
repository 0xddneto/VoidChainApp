// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title VoidProtocolTimelock
/// @notice A deliberately small delay between a protocol-governance decision
///         and its effect on-chain.
/// @dev The proposer may schedule or cancel, but cannot execute early or change
///      the delay. Anyone may execute an announced action during its grace
///      period, so losing the proposer key cannot censor an approved operation.
contract VoidProtocolTimelock is ReentrancyGuard {
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant GRACE_PERIOD = 14 days;

    address public immutable proposer;
    uint256 public immutable delay;
    mapping(bytes32 operation => uint256 executeAfter) public scheduled;

    event Scheduled(
        bytes32 indexed operation,
        address indexed target,
        uint256 value,
        bytes data,
        bytes32 salt,
        uint256 executeAfter
    );
    event Cancelled(bytes32 indexed operation);
    event Executed(bytes32 indexed operation, address indexed target, uint256 value, bytes result);

    error NotProposer(address caller);
    error ZeroAddress();
    error DelayTooShort(uint256 given, uint256 minimum);
    error AlreadyScheduled(bytes32 operation);
    error NotScheduled(bytes32 operation);
    error TooEarly(bytes32 operation, uint256 executeAfter);
    error Expired(bytes32 operation, uint256 expiredAt);
    error CallFailed(bytes reason);

    constructor(address proposer_, uint256 delay_) {
        if (proposer_ == address(0)) revert ZeroAddress();
        if (delay_ < MIN_DELAY) revert DelayTooShort(delay_, MIN_DELAY);
        proposer = proposer_;
        delay = delay_;
    }

    receive() external payable {}

    function operationId(address target, uint256 value, bytes calldata data, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, keccak256(data), salt));
    }

    function schedule(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        returns (bytes32 operation)
    {
        if (msg.sender != proposer) revert NotProposer(msg.sender);
        if (target == address(0)) revert ZeroAddress();
        operation = operationId(target, value, data, salt);
        if (scheduled[operation] != 0) revert AlreadyScheduled(operation);
        uint256 executeAfter = block.timestamp + delay;
        scheduled[operation] = executeAfter;
        emit Scheduled(operation, target, value, data, salt, executeAfter);
    }

    function cancel(bytes32 operation) external {
        if (msg.sender != proposer) revert NotProposer(msg.sender);
        if (scheduled[operation] == 0) revert NotScheduled(operation);
        delete scheduled[operation];
        emit Cancelled(operation);
    }

    function execute(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        nonReentrant
        returns (bytes memory result)
    {
        bytes32 operation = operationId(target, value, data, salt);
        uint256 executeAfter = scheduled[operation];
        if (executeAfter == 0) revert NotScheduled(operation);
        if (block.timestamp < executeAfter) revert TooEarly(operation, executeAfter);
        uint256 expiredAt = executeAfter + GRACE_PERIOD;
        if (block.timestamp > expiredAt) revert Expired(operation, expiredAt);

        delete scheduled[operation];
        (bool ok, bytes memory returned) = target.call{value: value}(data);
        if (!ok) revert CallFailed(returned);
        emit Executed(operation, target, value, returned);
        return returned;
    }
}
