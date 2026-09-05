// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidEmissionTokenV11 {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice Timelocked reserve with a hard rolling-epoch emission ceiling.
///         Governance can choose recipients but cannot drain the reserve in one
///         proposal, even after the delay.
contract VoidEmissionVaultV11 {
    address public immutable governor;
    uint64 public immutable delay;
    uint64 public immutable epochLength;
    uint256 public immutable epochCap;
    mapping(bytes32 => uint64) public etaOf;
    mapping(uint256 => uint256) public emittedInEpoch;

    event Scheduled(bytes32 indexed operationId, address indexed to, uint256 amount, uint64 eta);
    event Executed(bytes32 indexed operationId, address indexed to, uint256 amount, uint256 indexed epoch);

    error NotGovernor(address caller);
    error InvalidConfiguration();
    error AlreadyScheduled(bytes32 operationId);
    error NotScheduled(bytes32 operationId);
    error NotReady(uint64 eta);
    error EpochCapExceeded(uint256 requested, uint256 remaining);
    error TransferFailed();

    constructor(address governor_, uint64 delay_, uint64 epochLength_, uint256 epochCap_) {
        if (governor_ == address(0) || delay_ == 0 || epochLength_ == 0 || epochCap_ == 0) revert InvalidConfiguration();
        governor = governor_;
        delay = delay_;
        epochLength = epochLength_;
        epochCap = epochCap_;
    }

    function schedule(address token, address to, uint256 amount, bytes32 salt) external returns (bytes32 operationId) {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        if (token == address(0) || to == address(0) || amount == 0 || amount > epochCap) revert InvalidConfiguration();
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
        uint256 epoch = block.timestamp / epochLength;
        uint256 used = emittedInEpoch[epoch];
        if (amount > epochCap - used) revert EpochCapExceeded(amount, epochCap - used);
        delete etaOf[operationId];
        emittedInEpoch[epoch] = used + amount;
        if (!IVoidEmissionTokenV11(token).transfer(to, amount)) revert TransferFailed();
        emit Executed(operationId, to, amount, epoch);
    }
}
