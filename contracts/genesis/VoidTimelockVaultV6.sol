// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidTimelockToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title VoidTimelockVaultV6
/// @notice Token vault with no immediate administrator withdrawal path.
/// @dev Testnet uses the deployer as governor temporarily; mainnet must set a
/// governance executor. Every release is visible on-chain for `delay` first.
contract VoidTimelockVaultV6 {
    address public immutable governor;
    uint64 public immutable delay;
    mapping(bytes32 operationId => uint64) public etaOf;

    event Scheduled(bytes32 indexed operationId, address indexed to, uint256 amount, uint64 eta);
    event Executed(bytes32 indexed operationId, address indexed to, uint256 amount);

    error NotGovernor(address caller);
    error ZeroAddress();
    error AlreadyScheduled(bytes32 operationId);
    error NotScheduled(bytes32 operationId);
    error NotReady(uint64 eta);
    error TransferFailed();

    constructor(address governor_, uint64 delay_) {
        if (governor_ == address(0)) revert ZeroAddress();
        governor = governor_;
        delay = delay_;
    }

    function schedule(address token, address to, uint256 amount, bytes32 salt) external returns (bytes32 operationId) {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        if (token == address(0) || to == address(0) || amount == 0) revert ZeroAddress();
        operationId = keccak256(abi.encode(token, to, amount, salt));
        if (etaOf[operationId] != 0) revert AlreadyScheduled(operationId);
        uint64 eta = uint64(block.timestamp) + delay;
        etaOf[operationId] = eta;
        emit Scheduled(operationId, to, amount, eta);
    }

    function execute(address token, address to, uint256 amount, bytes32 salt) external {
        bytes32 operationId = keccak256(abi.encode(token, to, amount, salt));
        uint64 eta = etaOf[operationId];
        if (eta == 0) revert NotScheduled(operationId);
        if (block.timestamp < eta) revert NotReady(eta);
        delete etaOf[operationId];
        if (!IVoidTimelockToken(token).transfer(to, amount)) revert TransferFailed();
        emit Executed(operationId, to, amount);
    }
}
