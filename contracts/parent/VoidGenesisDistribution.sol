// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidGenesisToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title VoidGenesisDistribution
/// @notice Immutable buckets for the one-time VOID genesis supply.
/// @dev This mirrors the important Anvil property: tokens are held in a
/// reserve and can leave only through named, capped buckets. There is no owner
/// withdrawal and no hidden post-launch mint.
contract VoidGenesisDistribution {
    uint256 public constant BPS = 10_000;
    uint256 public constant LIQUIDITY_BPS = 4_000;
    uint256 public constant ECOSYSTEM_BPS = 3_000;
    uint256 public constant GOVERNANCE_BPS = 2_000;
    uint256 public constant COMMUNITY_BPS = 1_000;

    address public immutable liquidityVault;
    address public immutable ecosystemVault;
    address public immutable governanceVault;
    address public immutable communityVault;
    address public immutable governor;
    IVoidGenesisToken public token;

    bool public configured;
    mapping(address recipient => uint256) public allocation;
    mapping(address recipient => uint256) public released;

    event TokenConfigured(address indexed token, uint256 totalSupply);
    event Released(address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NotGovernor(address caller);
    error AlreadyConfigured();
    error NotConfigured();
    error NothingAvailable(address recipient);
    error TransferFailed();
    error BadSupply(uint256 balance, uint256 expected);

    constructor(
        address liquidityVault_,
        address ecosystemVault_,
        address governanceVault_,
        address communityVault_,
        address governor_
    ) {
        if (
            liquidityVault_ == address(0) || ecosystemVault_ == address(0)
                || governanceVault_ == address(0) || communityVault_ == address(0)
                || governor_ == address(0)
        ) revert ZeroAddress();
        liquidityVault = liquidityVault_;
        ecosystemVault = ecosystemVault_;
        governanceVault = governanceVault_;
        communityVault = communityVault_;
        governor = governor_;
    }

    /// @notice Binds the just-deployed fixed-supply token exactly once.
    /// @dev The token must already have transferred its entire supply here.
    function configureTokenOnce(IVoidGenesisToken token_, uint256 totalSupply) external {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        if (configured) revert AlreadyConfigured();
        if (address(token_) == address(0)) revert ZeroAddress();
        if (token_.balanceOf(address(this)) != totalSupply) {
            revert BadSupply(token_.balanceOf(address(this)), totalSupply);
        }
        token = token_;
        configured = true;
        allocation[liquidityVault] = (totalSupply * LIQUIDITY_BPS) / BPS;
        allocation[ecosystemVault] = (totalSupply * ECOSYSTEM_BPS) / BPS;
        allocation[governanceVault] = (totalSupply * GOVERNANCE_BPS) / BPS;
        allocation[communityVault] = (totalSupply * COMMUNITY_BPS) / BPS;
        emit TokenConfigured(address(token_), totalSupply);
    }

    /// @notice Releases only the recipient's fixed allocation.
    /// @dev Permissionless: the destination and amount are encoded in genesis.
    function release(address recipient) external returns (uint256 amount) {
        if (!configured) revert NotConfigured();
        amount = allocation[recipient] - released[recipient];
        if (amount == 0) revert NothingAvailable(recipient);
        released[recipient] += amount;
        if (!token.transfer(recipient, amount)) revert TransferFailed();
        emit Released(recipient, amount);
    }
}
