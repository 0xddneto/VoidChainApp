// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal surface of Arbitrum Nitro's ERC20Inbox on the parent chain.
///
/// @dev    CAREFUL: this is the interface of the **ERC20Inbox**, not the plain
///         Inbox.
///
///         A chain whose gas token is an ERC-20 — the case of the VOID Chains,
///         which use VOID — gets a different inbox, and the two signatures
///         diverge in a way that goes unnoticed until the first real call:
///
///           Inbox (ETH)      payable, 8 parameters, fee paid in msg.value
///           ERC20Inbox       NOT payable, 9 parameters, fee in tokenTotalFeeAmount
///
///         Using the wrong interface compiles, deploys, and only fails when
///         someone actually tries to command the chain — which is exactly how
///         this bug was found, in an integration test against testnet.
///
///         Each chain has its own Inbox, created by the RollupCreator on
///         activation. Sending a retryable through it is how the parent chain
///         emits an authenticated instruction to the child chain.
interface IArbitrumInbox {
    /// @notice Queues a parent→child message that executes `data` at `to`.
    ///
    /// @dev    On the child chain the message appears to come from the *aliased*
    ///         sender:
    ///         `address(uint160(msg.sender) + 0x1111000000000000000000000000000000001111)`.
    ///         That aliasing is what lets `VoidChainExecutor` prove the
    ///         instruction really came from `VoidChainController`, and not from
    ///         an impostor occupying the same address on the child chain.
    ///
    /// @param  tokenTotalFeeAmount Total gas token the inbox will pull from the
    ///         caller to fund the message. Requires a prior allowance.
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        uint256 tokenTotalFeeAmount,
        bytes calldata data
    ) external returns (uint256);
}
