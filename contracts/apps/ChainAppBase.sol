// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidChainAppRuntime {
    function executingChain() external view returns (uint256);
    function executingCaller() external view returns (address);
    function spendFrom(address token, address to, uint256 amount) external;
    function spendNftFrom(address collection, address to, uint256 tokenId) external;
}

/// @title ChainAppBase
/// @notice What a contract has to inherit to live inside a chainapp.
///
/// @dev    Two lines that make all the difference between "a contract on the
///         parent chain" and "a contract inside chain #N".
///
///         `onlyFromMyChain` guarantees that nobody reaches this contract from
///         outside the runtime — anyone calling it directly, without paying the
///         toll, is refused. Without that, the chain's economy would be
///         optional: calling the app directly would be enough to use it for
///         free, and the deed owner would never receive anything.
///
///         `caller()` returns the real user. Without it, every app would see
///         `msg.sender` as the runtime and treat all users as a single person —
///         balances, permissions and ownership would collapse into one address.
abstract contract ChainAppBase {
    IVoidChainAppRuntime public immutable runtime;

    /// @notice The chain this contract belongs to. Immutable: an app does not
    ///         change chains, the same way a contract does not change
    ///         blockchains.
    uint256 public immutable chainId;

    error NotFromRuntime(uint256 executing, uint256 expected);
    error NotCalledByRuntime(address caller);
    error ZeroAddress();

    constructor(IVoidChainAppRuntime runtime_, uint256 chainId_) {
        if (address(runtime_) == address(0)) revert ZeroAddress();
        runtime = runtime_;
        chainId = chainId_;
    }

    /// @dev    TWO CONDITIONS, AND THE FIRST IS THE ONE THAT MATTERS.
    ///
    ///         Checking only `executingChain` leaves the confused-deputy attack
    ///         open: while an execution is under way, EVERY contract of that
    ///         chain reads the same chain and the same user, no matter who
    ///         called it. A hostile application published on the same chain —
    ///         which anyone can do — would call this one directly, and this one
    ///         would conclude the request came from the user.
    ///
    ///         Requiring the caller to be the runtime closes that: there is only
    ///         one path here, and it goes through the toll.
    modifier onlyFromMyChain() {
        if (msg.sender != address(runtime)) revert NotCalledByRuntime(msg.sender);
        uint256 executing = runtime.executingChain();
        if (executing != chainId) revert NotFromRuntime(executing, chainId);
        _;
    }

    /// @notice Who is using the app right now.
    function caller() internal view returns (address) {
        return runtime.executingCaller();
    }

    /// @notice Moves the current user's tokens, within what they authorized.
    ///
    /// @dev    USE THIS, NOT `transferFrom(caller(), ...)`. The difference
    ///         decides whether your application works for people with no ETH.
    ///
    ///         A direct `transferFrom` requires the user to have given
    ///         `approve` to YOUR contract — and giving `approve` is a
    ///         transaction, which someone holding only VOID cannot send. Every
    ///         application that pulls tokens directly forces the user to find
    ///         ETH once, just to be able to use it.
    ///
    ///         Through here, the user authorizes the runtime ONCE, by signature,
    ///         and declares in the call itself how much each application may
    ///         spend. The runtime checks that you are a registered application
    ///         of the executing chain and that the amount fits what they signed.
    function spend(address token, address to, uint256 amount) internal {
        runtime.spendFrom(token, to, amount);
    }

    /// @notice Moves an NFT from the current user, if they authorized THIS token.
    ///
    /// @dev    THE PATH IS HERE, BUT THE CHOICE IS YOURS. Use this and your
    ///         application works for people with no ETH — the user authorizes
    ///         the NFT by signature, inside the request. Use the ERC-721's
    ///         `transferFrom` directly and it also works, only requiring a
    ///         `setApprovalForAll` from each user, which is a transaction, which
    ///         someone holding only VOID cannot send.
    ///
    ///         Neither one is forbidden. The first closes the bubble; the second
    ///         is what every NFT marketplace already does today.
    function spendNft(address collection, address to, uint256 tokenId) internal {
        runtime.spendNftFrom(collection, to, tokenId);
    }
}
