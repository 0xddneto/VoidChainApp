// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Nitro's owner precompile, present on every Orbit chain at a fixed address.
interface IArbOwner {
    function setMinimumL2BaseFee(uint256 priceInWei) external;
    function setNetworkFeeAccount(address newNetworkFeeAccount) external;
    function setInfraFeeAccount(address newInfraFeeAccount) external;
    function addChainOwner(address newOwner) external;
    function removeChainOwner(address ownerToRemove) external;
}

/// @title VoidChainExecutor
/// @notice Lives on the chain's own chain and is its only registered chain owner.
///
/// @dev    This contract is the reason a deed sale cannot become a rug.
///
///         It is registered via `ArbOwner.addChainOwner(address(this))` at genesis,
///         and then every *other* chain owner -- including the deployer EOA that
///         bootstrapped the chain -- is removed. After that, the only way to reach
///         ArbOwner is through this contract, and the only way to reach this
///         contract is a parent-chain message from `VoidChainController`.
///
///         Authentication is by address aliasing. When the Inbox delivers a
///         parent-to-child message, Nitro rewrites the sender to
///         `sender + 0x1111000000000000000000000000000000001111`. An attacker who
///         deploys to the controller's address on THIS chain therefore does not
///         match, because they would arrive un-aliased. This is the same mechanism
///         the Arbitrum DAO uses to govern its own chains.
///
///         Note what is deliberately absent: this contract exposes no way to add a
///         chain owner, and no generic call forwarder. Both are the escape hatches
///         that would collapse the three-tier authority model back into "whoever
///         holds the NFT owns everything".
contract VoidChainExecutor {
    IArbOwner internal constant ARB_OWNER = IArbOwner(0x0000000000000000000000000000000000000070);

    uint160 internal constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    /// @notice `VoidChainController` on the parent chain, in its un-aliased form.
    address public immutable controller;

    /// @notice This chain's revenue vault on this chain. Fixed at genesis so that
    ///         no instruction, from anyone, can redirect the fee stream.
    address public immutable feeCollector;

    event MinBaseFeeApplied(uint256 value);

    error NotAliasedController(address caller, address expected);
    error ZeroAddress();

    constructor(address controller_, address feeCollector_) {
        // Both are immutable: a zero address here would produce a chain whose
        // executor never accepts an instruction, or whose revenue is burned —
        // with no way to fix it afterwards.
        if (controller_ == address(0) || feeCollector_ == address(0)) revert ZeroAddress();
        controller = controller_;
        feeCollector = feeCollector_;
    }

    modifier onlyController() {
        // The sum has to WRAP at 2^160, not revert on overflow.
        //
        // Arbitrum's real aliasing is modulo 2^160. In Solidity 0.8 a uint160
        // addition is checked and reverts if it overflows — so if the
        // controller's address on the parent chain were high enough (close to
        // 0xFFFF…), this modifier would always revert and the executor would be
        // unreachable: a chain with no operable owner, beyond repair.
        // `unchecked` aligns the arithmetic with Arbitrum's. Found in red-team
        // (L3 path).
        address expected;
        unchecked {
            expected = address(uint160(controller) + ALIAS_OFFSET);
        }
        if (msg.sender != expected) revert NotAliasedController(msg.sender, expected);
        _;
    }

    /// @notice Applies a min base fee already validated and timelocked upstream.
    /// @dev    No range check here. The bound is enforced on the parent chain,
    ///         where the deed is readable; duplicating it here would let the two
    ///         drift apart and create a rule that is true in one place only.
    function applyMinBaseFee(uint256 priceInWei) external onlyController {
        ARB_OWNER.setMinimumL2BaseFee(priceInWei);
        emit MinBaseFeeApplied(priceInWei);
    }

    /// @notice Points both fee streams at this chain's vault.
    /// @dev    Callable once at genesis by the controller. `feeCollector` is
    ///         immutable, so this is idempotent and cannot be repurposed.
    function bindFeeAccounts() external onlyController {
        ARB_OWNER.setNetworkFeeAccount(feeCollector);
        ARB_OWNER.setInfraFeeAccount(feeCollector);
    }
}
