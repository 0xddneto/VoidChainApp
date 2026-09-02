// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Nitro's precompile for child→parent messages, at 0x64 everywhere.
interface IArbSys {
    /// @notice Withdraws the chain's native token to an address on the parent chain.
    /// @dev    On a chain with a custom gas token, "native" means VOID. The value
    ///         leaves here immediately, but only becomes available there after
    ///         the rollup's dispute period — that is the price of being able to
    ///         exit without asking permission.
    function withdrawEth(address destination) external payable returns (uint256);
}

/// @title VoidChainFeeVault
/// @notice Where a VOID Chain's gas revenue accumulates, inside the chain
///         itself, before crossing over to the treasury on the parent chain.
///
/// @dev    WHY THIS CONTRACT HAS TO EXIST.
///
///         Nitro credits gas fees straight into the balance of two addresses the
///         chain knows: `networkFeeAccount` and `infraFeeAccount`. That is a
///         balance credit, not a function call — no contract runs when the money
///         arrives. Any plain address would do for accumulating, but then
///         somebody would have to hold its key, and that key would become a
///         second owner of the chain's revenue, alongside the NFT.
///
///         This contract is the address that accumulates AND has no owner. The
///         destination is `immutable`, `sweep()` is open to anyone, and there is
///         no other way out: whoever calls it does not choose where the money
///         goes, only when.
///
///         WHAT IT DELIBERATELY DOES NOT HAVE.
///
///         No rescue function, no administrator, no path to send the balance to
///         an address chosen on the spot. Any of those would turn the revenue of
///         1,111 chains into an account somebody operates — and the promise that
///         the income belongs to whoever holds the NFT would become a promise
///         that somebody will pass it along.
contract VoidChainFeeVault {
    IArbSys internal constant ARB_SYS = IArbSys(0x0000000000000000000000000000000000000064);

    /// @notice Where the revenue goes on the parent chain: this chain's router.
    /// @dev    Immutable on purpose. If this address could change, whoever could
    ///         change it would be the real owner of the income.
    address public immutable destination;

    /// @notice How much has crossed so far, for the explorer and for auditing.
    uint256 public lifetimeSwept;

    event Swept(uint256 amount, uint256 messageId, address caller);

    error NothingToSweep();
    error ZeroAddress();

    constructor(address destination_) {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
    }

    /// @notice Sends everything accumulated to the parent chain.
    ///
    /// @dev    Open to anyone, and that is a decision, not an oversight. The
    ///         destination is fixed, so the caller has nothing to gain beyond
    ///         paying the gas for a transfer that was going to happen anyway.
    ///         Restricting the function would create a chain whose revenue gets
    ///         stuck if the operator disappears.
    function sweep() external returns (uint256 messageId) {
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToSweep();

        lifetimeSwept += amount;
        messageId = ARB_SYS.withdrawEth{value: amount}(destination);

        emit Swept(amount, messageId, msg.sender);
    }

    /// @notice Accepts the gas fees and any donation.
    /// @dev    Nitro credits the fees straight into the balance, calling nothing,
    ///         but `receive` is needed for ordinary transfers — including from
    ///         anyone who wants to fund the chain.
    receive() external payable {}
}
