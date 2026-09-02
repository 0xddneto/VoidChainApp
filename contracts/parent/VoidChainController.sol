// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IArbitrumInbox} from "../interfaces/IArbitrumInbox.sol";

interface IGasToken {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IVoidChainDeed {
    function ownerOf(uint256 tokenId) external view returns (address);
    function chainIdOf(uint256 tokenId) external view returns (uint256);
}

/// @title VoidChainController
/// @notice The chain owner of every chain chain, living on the parent chain.
///
/// @dev    THE CENTRAL SECURITY IDEA OF THE PROTOCOL.
///
///         A naive design makes the deed holder the chain owner directly. That
///         design is unbuildable-on: whoever buys the deed inherits the power to
///         upgrade system contracts, drain the bridge, and rewrite the rules under
///         applications that third parties deployed. No serious developer builds
///         on a chain whose administrator can change for the price of an NFT.
///
///         So authority is split in three tiers that no deed transfer can cross:
///
///           TIER 1  DEED HOLDER      economic + cosmetic parameters, bounded.
///                                    Every function below is individually typed
///                                    and range-checked. There is deliberately NO
///                                    generic `execute(target, data)` entry point,
///                                    because an allowlist of *selectors* still
///                                    lets a hostile owner pass hostile *arguments*
///                                    (e.g. pointing the fee account at themselves,
///                                    or adding a second chain owner and escaping
///                                    this contract entirely).
///
///           TIER 2  PROTOCOL GOV     verifier/bridge/system-contract upgrades,
///                                    behind a timelock, global across chains.
///                                    Never follows the deed.
///
///           TIER 3  NOBODY           chain ID, genesis, finalised history, user
///                                    balances, the right to exit.
///
///         The deed holder owns the *revenue and the identity* of a chain.
///         They never own the *safety* of the people using it.
contract VoidChainController {
    IVoidChainDeed public immutable deed;

    /// @notice The chains' gas token — VOID.
    /// @dev    On a chain with a custom gas token the inbox is NOT payable: the
    ///         parent-to-child message is funded in the token, not in ETH. That
    ///         is why the controller has to know the token and move the amount
    ///         from the caller to the inbox.
    IGasToken public immutable gasToken;

    /// @notice Protocol-level governance. Expected to be a timelocked multisig or
    ///         DAO. Deliberately NOT reachable from any deed.
    address public governance;

    /// @notice Per-chain activation record, written when the Orbit chain is deployed.
    struct VoidChain {
        IArbitrumInbox inbox; // parent-chain inbox of this chain's chain
        address executor; // VoidChainExecutor address on the child chain
        address feeVault; // where this chain's revenue accrues
        bool activated;
    }

    mapping(uint256 tokenId => VoidChain) public chains;

    // --- Bounded parameter space for TIER 1 -------------------------------
    // A deed holder may move fees only inside this window. The floor keeps a
    // chain from underpricing below its own settlement cost and stranding the
    // sequencer; the ceiling keeps a new buyer from making an existing app's
    // users pay an extortionate fee overnight.

    uint256 public minBaseFeeFloor = 0.001 gwei;
    uint256 public minBaseFeeCeiling = 10 gwei;

    /// @notice Fee increases wait; fee decreases are immediate.
    /// @dev    Asymmetric on purpose. Lowering a fee never harms an existing user,
    ///         so it should not be delayed. Raising one does, so users get a window
    ///         to exit or migrate before it binds.
    uint256 public constant FEE_INCREASE_DELAY = 3 days;

    struct PendingFee {
        uint256 value;
        uint256 executableAt;
    }

    mapping(uint256 tokenId => uint256) public currentBaseFee;
    mapping(uint256 tokenId => PendingFee) public pendingBaseFee;

    event VoidChainActivated(uint256 indexed tokenId, uint256 chainId, address inbox, address executor);
    event ExecutorMigrated(uint256 indexed tokenId, address previous, address next);
    event FeeAccountsBound(uint256 indexed tokenId, address executor);
    event BaseFeeIncreaseScheduled(uint256 indexed tokenId, uint256 value, uint256 executableAt);
    event BaseFeeApplied(uint256 indexed tokenId, uint256 value);
    event FeeVaultUpdated(uint256 indexed tokenId, address vault);
    event GovernanceTransferred(address previous, address next);

    error NotDeedHolder(uint256 tokenId, address caller);
    error NotGovernance(address caller);
    error VoidChainNotActivated(uint256 tokenId);
    error VoidChainAlreadyActivated(uint256 tokenId);
    error FeeOutOfBounds(uint256 value, uint256 floor, uint256 ceiling);
    error NothingPending(uint256 tokenId);
    error TimelockNotElapsed(uint256 executableAt);
    error ZeroAddress();
    error InsufficientTicketValue();
    error SameExecutor(address executor);

    constructor(IVoidChainDeed deed_, IGasToken gasToken_, address governance_) {
        if (
            address(deed_) == address(0) || address(gasToken_) == address(0)
                || governance_ == address(0)
        ) revert ZeroAddress();
        deed = deed_;
        gasToken = gasToken_;
        governance = governance_;
    }

    modifier onlyDeedHolder(uint256 tokenId) {
        if (deed.ownerOf(tokenId) != msg.sender) revert NotDeedHolder(tokenId, msg.sender);
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // TIER 2 -- activation (protocol only; deploying a chain costs real money
    // and must be sequenced by the operator, not triggered by an NFT holder)
    // ---------------------------------------------------------------------

    function activateChain(
        uint256 tokenId,
        IArbitrumInbox inbox,
        address executor,
        address feeVault
    ) external onlyGovernance {
        if (chains[tokenId].activated) revert VoidChainAlreadyActivated(tokenId);
        if (address(inbox) == address(0) || executor == address(0) || feeVault == address(0)) {
            revert ZeroAddress();
        }

        chains[tokenId] =
            VoidChain({inbox: inbox, executor: executor, feeVault: feeVault, activated: true});

        emit VoidChainActivated(tokenId, deed.chainIdOf(tokenId), address(inbox), executor);
    }

    // ---------------------------------------------------------------------
    // TIER 1 -- what the deed holder may actually do
    // ---------------------------------------------------------------------

    /// @notice Schedules (increase) or applies immediately (decrease) the minimum
    ///         base fee of the chain's chain.
    /// @param  ticketFee How much of the gas token funds the message to the
    ///         chain. The caller must have given this contract an allowance.
    function setMinBaseFee(uint256 tokenId, uint256 newFee, uint256 ticketFee)
        external
        onlyDeedHolder(tokenId)
    {
        _requireActivated(tokenId);
        if (newFee < minBaseFeeFloor || newFee > minBaseFeeCeiling) {
            revert FeeOutOfBounds(newFee, minBaseFeeFloor, minBaseFeeCeiling);
        }

        // The first setting is immediate, and the reason is the same one that
        // justifies the timelock: it exists to give people already using the
        // chain time to leave before a fee rises. On a chain that never had a
        // fee, there is nobody to protect — only an owner waiting three days to
        // configure what they just created.
        //
        // Found by test: without this clause, `currentBaseFee` starts at zero
        // and ANY initial value counts as an increase.
        if (newFee <= currentBaseFee[tokenId] || currentBaseFee[tokenId] == 0) {
            _pushMinBaseFee(tokenId, newFee, ticketFee);
        } else {
            uint256 executableAt = block.timestamp + FEE_INCREASE_DELAY;
            pendingBaseFee[tokenId] = PendingFee({value: newFee, executableAt: executableAt});
            emit BaseFeeIncreaseScheduled(tokenId, newFee, executableAt);
        }
    }

    /// @notice Applies a fee increase whose timelock has elapsed.
    /// @dev    Permissionless on purpose: the schedule is the authorisation, and
    ///         whoever pays the ticket gas may push it.
    function applyPendingBaseFee(uint256 tokenId, uint256 ticketFee) external {
        PendingFee memory pending = pendingBaseFee[tokenId];
        if (pending.executableAt == 0) revert NothingPending(tokenId);
        if (block.timestamp < pending.executableAt) revert TimelockNotElapsed(pending.executableAt);

        delete pendingBaseFee[tokenId];
        _pushMinBaseFee(tokenId, pending.value, ticketFee);
    }

    /// @dev Sends the authenticated instruction down to the child chain, where
    ///      `VoidChainExecutor` verifies the aliased sender and calls ArbOwner.
    /// @dev The token goes from the caller to the inbox in two steps, because
    ///      the inbox pulls the amount itself: first we bring it here, then we
    ///      grant the allowance. Approving straight from the caller to the inbox
    ///      would force every owner to know their own chain's inbox address.
    function _pushMinBaseFee(uint256 tokenId, uint256 newFee, uint256 ticketFee) internal {
        VoidChain memory chain = chains[tokenId];
        currentBaseFee[tokenId] = newFee;

        if (ticketFee == 0) revert InsufficientTicketValue();
        gasToken.transferFrom(msg.sender, address(this), ticketFee);
        gasToken.approve(address(chain.inbox), ticketFee);

        bytes memory payload = abi.encodeWithSignature("applyMinBaseFee(uint256)", newFee);

        chain.inbox.createRetryableTicket({
            to: chain.executor,
            l2CallValue: 0,
            maxSubmissionCost: ticketFee / 4,
            excessFeeRefundAddress: msg.sender,
            callValueRefundAddress: msg.sender,
            gasLimit: 300_000,
            maxFeePerGas: 1 gwei,
            tokenTotalFeeAmount: ticketFee,
            data: payload
        });

        emit BaseFeeApplied(tokenId, newFee);
    }

    function _requireActivated(uint256 tokenId) internal view {
        if (!chains[tokenId].activated) revert VoidChainNotActivated(tokenId);
    }

    // ---------------------------------------------------------------------
    // TIER 2 -- protocol governance
    // ---------------------------------------------------------------------

    /// @notice Tells the chain to point both of its fee accounts at its vault.
    ///
    /// @dev    Without this call, the chain keeps crediting all gas revenue to
    ///         the address Nitro picked at genesis — in practice, the key that
    ///         deployed the chain. The protocol's entire economy stays switched
    ///         off, and silently: the chain works, charges gas, and the money
    ///         simply does not go where the NFT promises.
    ///
    ///         It is TIER 2 because it is installation, not an economic
    ///         decision: the destination is already fixed as `immutable` inside
    ///         the executor, so neither this function nor its caller chooses
    ///         where the money goes. The only thing decided here is when to
    ///         switch it on.
    function bindFeeAccounts(uint256 tokenId, uint256 ticketFee) external onlyGovernance {
        _requireActivated(tokenId);
        if (ticketFee == 0) revert InsufficientTicketValue();

        VoidChain memory chain = chains[tokenId];

        gasToken.transferFrom(msg.sender, address(this), ticketFee);
        gasToken.approve(address(chain.inbox), ticketFee);

        chain.inbox.createRetryableTicket({
            to: chain.executor,
            l2CallValue: 0,
            maxSubmissionCost: ticketFee / 4,
            excessFeeRefundAddress: msg.sender,
            callValueRefundAddress: msg.sender,
            gasLimit: 300_000,
            maxFeePerGas: 1 gwei,
            tokenTotalFeeAmount: ticketFee,
            data: abi.encodeWithSignature("bindFeeAccounts()")
        });

        emit FeeAccountsBound(tokenId, chain.executor);
    }

    /// @notice Swaps a chain's executor. Immediate.
    ///
    /// @dev    WHY IT EXISTS.
    ///
    ///         The executor records the controller's address as `immutable`, and
    ///         this function records the executor's at activation. With no way to
    ///         swap, the pair is born welded together: any ordering mistake in
    ///         the deploy, or any defect found in the executor later, produces a
    ///         chain that runs, accepts transactions and obeys nobody any more.
    ///         The project's first two chains were born exactly like that.
    ///
    ///         WHY IT HAS NO DELAY.
    ///
    ///         A delay is a tool to protect people already using the chain from a
    ///         change that harms them — that is why a fee INCREASE waits three
    ///         days and a decrease waits for nothing. Replacing a broken executor
    ///         does not fit that category: it does not touch anyone's price,
    ///         balance or contract. Making the fix wait would only prolong the
    ///         defect it comes to repair, and a chain without a working executor
    ///         has no users to protect — it has users trapped.
    ///
    ///         WHAT THIS IS NOT.
    ///
    ///         It is not a door for governance to take the chain from whoever
    ///         holds the NFT. The new executor still only accepts orders coming
    ///         from this contract, and this contract still reads
    ///         `ownerOf(tokenId)` on every call. Replacing the executor changes
    ///         the lock, never the owner of the key.
    ///
    ///         WHAT THIS COSTS, SAID PLAINLY.
    ///
    ///         Being immediate, governance can point a chain at a hostile
    ///         executor in the same block it decides to, and nobody sees it
    ///         coming. The event below is the only defense: it makes the swap
    ///         public at the instant it happens, for anyone watching. Whoever
    ///         trusts the chain is trusting the protocol's governance — which is
    ///         exactly the same trust that was already required for system
    ///         upgrades.
    function migrateExecutor(uint256 tokenId, address newExecutor) external onlyGovernance {
        _requireActivated(tokenId);
        if (newExecutor == address(0)) revert ZeroAddress();
        if (newExecutor == chains[tokenId].executor) revert SameExecutor(newExecutor);

        address previous = chains[tokenId].executor;
        chains[tokenId].executor = newExecutor;

        // The current fee is cleared on purpose. The new executor inherits the
        // chain with the `minimumL2BaseFee` Nitro actually has, not the one this
        // contract believes it has — and the owner's first order after the swap
        // becomes immediate again, instead of waiting three days for an
        // "increase" that exists only in this contract's bookkeeping.
        currentBaseFee[tokenId] = 0;

        emit ExecutorMigrated(tokenId, previous, newExecutor);
    }

    function setFeeBounds(uint256 floor, uint256 ceiling) external onlyGovernance {
        minBaseFeeFloor = floor;
        minBaseFeeCeiling = ceiling;
    }

    function transferGovernance(address next) external onlyGovernance {
        if (next == address(0)) revert ZeroAddress();
        emit GovernanceTransferred(governance, next);
        governance = next;
    }
}
