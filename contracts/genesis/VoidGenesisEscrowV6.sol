// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidEscrowToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title VoidGenesisEscrowV6
/// @notice Holds the full fixed VOID supply and releases it only through
/// genesis routes with hard, public caps.
contract VoidGenesisEscrowV6 {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant NFT_AMM_CAP = 555_500_000e18;
    uint256 public constant LP_CAP = 222_200_000e18;
    uint256 public constant BUILDER_CAP = 150_000_000e18;
    uint256 public constant PROTOCOL_CAP = 72_300_000e18;

    address public immutable bootstrapGovernor;
    IVoidEscrowToken public token;
    address public launch;
    address public liquidityPool;
    address public nftAmm;
    bool public configured;
    uint256 public lpReleased;
    uint256 public nftAmmReleased;
    mapping(uint256 tokenId => bool) public deedReleased;

    event Configured(address indexed token, address indexed launch, address indexed pool);
    event LiquidityReleased(uint256 amount, uint256 cumulative);
    event NftValueReleased(uint256 indexed deedId, address indexed to, uint256 amount);
    event NftAmmSet(address indexed nftAmm);

    error ZeroAddress();
    error NotBootstrapGovernor(address caller);
    error NotLaunch(address caller);
    error NotNftAmm(address caller);
    error AlreadyConfigured();
    error NotConfigured();
    error NftAmmAlreadySet(address current);
    error InvalidDeed(uint256 tokenId);
    error DeedAlreadyReleased(uint256 tokenId);
    error CapExceeded(uint256 requested, uint256 available);
    error BadSupply(uint256 balance);
    error TransferFailed();

    constructor(address governor_) {
        if (governor_ == address(0)) revert ZeroAddress();
        bootstrapGovernor = governor_;
    }

    function configureOnce(
        IVoidEscrowToken token_,
        address launch_,
        address liquidityPool_,
        address builderVault,
        address protocolVault
    ) external {
        if (msg.sender != bootstrapGovernor) revert NotBootstrapGovernor(msg.sender);
        if (configured) revert AlreadyConfigured();
        if (
            address(token_) == address(0) || launch_ == address(0) || liquidityPool_ == address(0)
                || builderVault == address(0) || protocolVault == address(0)
        ) revert ZeroAddress();
        if (token_.balanceOf(address(this)) != TOTAL_SUPPLY) {
            revert BadSupply(token_.balanceOf(address(this)));
        }
        token = token_;
        launch = launch_;
        liquidityPool = liquidityPool_;
        configured = true;
        if (!token_.transfer(builderVault, BUILDER_CAP)) revert TransferFailed();
        if (!token_.transfer(protocolVault, PROTOCOL_CAP)) revert TransferFailed();
        emit Configured(address(token_), launch_, liquidityPool_);
    }

    function setNftAmmOnce(address nftAmm_) external {
        if (msg.sender != bootstrapGovernor) revert NotBootstrapGovernor(msg.sender);
        if (!configured) revert NotConfigured();
        if (nftAmm != address(0)) revert NftAmmAlreadySet(nftAmm);
        if (nftAmm_ == address(0)) revert ZeroAddress();
        nftAmm = nftAmm_;
        emit NftAmmSet(nftAmm_);
    }

    /// @notice Releases 200,000 VOID per ETH mint to keep pool price equal to
    /// the 500,000 VOID-per-Deed AMM base rate.
    function releaseLiquidity(uint256 amount) external {
        if (!configured) revert NotConfigured();
        if (msg.sender != launch) revert NotLaunch(msg.sender);
        uint256 next = lpReleased + amount;
        if (next > LP_CAP) revert CapExceeded(amount, LP_CAP - lpReleased);
        lpReleased = next;
        if (!token.transfer(liquidityPool, amount)) revert TransferFailed();
        emit LiquidityReleased(amount, next);
    }

    /// @notice Pays the exact 500,000 VOID base value only once for a Deed that
    /// the authorized NFT AMM has taken into custody.
    function releaseNftValue(uint256 deedId, address to) external returns (uint256 amount) {
        if (!configured) revert NotConfigured();
        if (msg.sender != nftAmm) revert NotNftAmm(msg.sender);
        if (deedId == 0 || deedId > 1111) revert InvalidDeed(deedId);
        if (deedReleased[deedId]) revert DeedAlreadyReleased(deedId);
        deedReleased[deedId] = true;
        amount = 500_000e18;
        uint256 next = nftAmmReleased + amount;
        if (next > NFT_AMM_CAP) revert CapExceeded(amount, NFT_AMM_CAP - nftAmmReleased);
        nftAmmReleased = next;
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit NftValueReleased(deedId, to, amount);
    }
}
