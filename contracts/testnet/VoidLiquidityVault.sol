// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidLiquidityToken {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title VoidLiquidityVault
/// @notice Holds the immutable genesis liquidity allocation until one pool is
/// explicitly pinned on-chain.
/// @dev It cannot withdraw to a wallet. It can seed only the one pool selected
/// once, which prevents the launch allocation from becoming a hidden treasury.
contract VoidLiquidityVault {
    address public immutable governor;
    address public pool;

    event PoolPinned(address indexed pool);
    event Seeded(address indexed pool, address indexed token, uint256 tokens, uint256 eth);
    event Funded(address indexed from, uint256 amount);

    error NotGovernor(address caller);
    error ZeroAddress();
    error PoolAlreadyPinned(address pool);
    error NotContract(address target);
    error PoolNotPinned();
    error TokenTransferFailed();
    error EthTransferFailed();
    error AmountAboveBalance();

    constructor(address governor_) {
        if (governor_ == address(0)) revert ZeroAddress();
        governor = governor_;
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    function pinPoolOnce(address pool_) external {
        if (msg.sender != governor) revert NotGovernor(msg.sender);
        if (pool != address(0)) revert PoolAlreadyPinned(pool);
        if (pool_ == address(0)) revert ZeroAddress();
        if (pool_.code.length == 0) revert NotContract(pool_);
        pool = pool_;
        emit PoolPinned(pool_);
    }

    /// @notice Seeds only the previously pinned liquidity contract.
    function seed(IVoidLiquidityToken token, uint256 tokenAmount, uint256 ethAmount) external {
        address target = pool;
        if (target == address(0)) revert PoolNotPinned();
        if (ethAmount > address(this).balance) revert AmountAboveBalance();
        if (tokenAmount > 0 && !token.transfer(target, tokenAmount)) revert TokenTransferFailed();
        if (ethAmount > 0) {
            (bool ok,) = payable(target).call{value: ethAmount}("");
            if (!ok) revert EthTransferFailed();
        }
        emit Seeded(target, address(token), tokenAmount, ethAmount);
    }
}
