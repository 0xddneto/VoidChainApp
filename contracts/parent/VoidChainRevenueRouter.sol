// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IVoidChainTreasury {
    function settle(uint256 tokenId, uint256 amount) external;
}

/// @title VoidChainRevenueRouter
/// @notice The address, on the parent chain, where ONE chain's revenue lands.
///
/// @dev    WHY NOT WITHDRAW STRAIGHT TO THE TREASURY.
///
///         A child→parent withdrawal delivers VOID to an address and that is all
///         — it is a balance credit, not a function call. If it pointed straight
///         at the treasury, the money would arrive there with nobody knowing
///         WHICH chain it came from, and the treasury needs to know: it is the
///         `tokenId` that decides who gets paid.
///
///         Solving that with a treasury function along the lines of "credit this
///         balance to chain N" would be worse: anyone could point one chain's
///         revenue at another. The information has to come from somewhere that
///         cannot lie.
///
///         This contract is that place. There is one per chain, the `tokenId` is
///         `immutable`, and the only thing it does is push what it received into
///         the treasury under that number. The address the chain withdraws to is
///         itself the proof of where the money came from.
contract VoidChainRevenueRouter {
    /// @notice The chain whose revenue passes through here. Never changes.
    uint256 public immutable tokenId;

    IVoidChainTreasury public immutable treasury;
    IERC20 public immutable voidToken;

    /// @notice How much this router has forwarded to the treasury so far.
    uint256 public lifetimeRouted;

    event Routed(uint256 indexed tokenId, uint256 amount, address caller);

    error NothingToRoute();
    error ZeroAddress();

    constructor(uint256 tokenId_, IVoidChainTreasury treasury_, IERC20 voidToken_) {
        if (address(treasury_) == address(0) || address(voidToken_) == address(0)) {
            revert ZeroAddress();
        }
        tokenId = tokenId_;
        treasury = treasury_;
        voidToken = voidToken_;
    }

    /// @notice Pushes every VOID that arrived here into the treasury.
    ///
    /// @dev    Open to anyone, for the same reason as `sweep()` back on the child
    ///         chain: the destination and the `tokenId` are fixed, so the caller
    ///         has no choice to make — they only pay the gas for a transfer that
    ///         was already decided. Restricting it would create a chain whose
    ///         income locks up if the operator stops showing up.
    function flush() external returns (uint256 amount) {
        amount = voidToken.balanceOf(address(this));
        if (amount == 0) revert NothingToRoute();

        lifetimeRouted += amount;

        // An exact approval on every transfer: an infinite allowance here would
        // gain nothing and would leave a permanent authorization standing over a
        // contract whose only purpose is to empty itself.
        voidToken.approve(address(treasury), amount);
        treasury.settle(tokenId, amount);

        emit Routed(tokenId, amount, msg.sender);
    }
}
