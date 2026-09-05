// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidChainAppRuntime {
    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external;
}

interface IVoidChainDeed {
    function ownerOf(uint256 tokenId) external view returns (address);
    function ownershipEpoch(uint256 tokenId) external view returns (uint256);
}

/// @notice ERC-20 voting snapshots without custody or token locking.
interface IVoidVotes {
    function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
    function getPastTotalSupply(uint256 blockNumber) external view returns (uint256);
}

/// @title VoidChainDao
/// @notice One DAO per deed. VOID always stays in each voter's wallet.
/// @dev Voting weight comes from the previous block. A live balance would allow
///      the same VOID to move to another wallet and vote again; this snapshot
///      prevents that without staking, locking, approvals or withdrawals.
contract VoidChainDao {
    uint256 public constant VOTING_PERIOD = 5 days;
    // 1% of eligible circulation. Protocol escrow, locked liquidity and the
    // immutable reserve accounts are removed by VoidGovernanceVotes before
    // this percentage is applied. Wallet-held VOID remains fully liquid.
    uint256 public constant QUORUM_BPS = 100;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_ACTIONS = 8;
    uint256 public constant MAX_ACTION_DATA_BYTES = 8_192;
    uint256 public constant MAX_DESCRIPTION_BYTES = 1_024;

    uint256 public tokenId;
    IVoidChainAppRuntime public runtime;
    IVoidVotes public voidToken;
    IVoidChainDeed public deed;

    enum State {
        Pending,
        Active,
        Defeated,
        Succeeded,
        Executed
    }

    /// @notice A zero-value call to be executed by this DAO after a successful vote.
    /// @dev The target contract still decides whether this DAO has authority. The
    ///      DAO for chain #7 is not automatically trusted by the runtime, the
    ///      treasury, the paymaster or any other chain.
    struct Action {
        address target;
        bytes data;
    }

    struct Proposal {
        bytes32 actionsHash;
        bytes32 descriptionHash;
        uint256 snapshotBlock;
        uint256 snapshotSupply;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 actionCount;
        bool executed;
    }

    mapping(uint256 proposalId => Proposal) public proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
    mapping(uint256 proposalId => string description) private _descriptions;
    mapping(uint256 proposalId => Action[]) private _actions;
    mapping(uint256 proposalId => uint256) public proposalOwnershipEpoch;
    uint256 public proposalCount;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        bytes32 indexed actionsHash,
        uint256 actionCount,
        uint256 snapshotBlock,
        uint256 deadline
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ActionExecuted(uint256 indexed proposalId, uint256 indexed actionIndex, address indexed target);
    event Executed(uint256 indexed proposalId, bytes32 actionsHash);

    error AlreadyInitialised();
    error NotInitialised();
    error ZeroAddress();
    error NotDeedHolder(uint256 tokenId, address caller);
    error EmptySnapshot();
    error NoSuchProposal(uint256 proposalId);
    error VotingClosed(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error NoVotingPower(uint256 proposalId, address voter);
    error NotSucceeded(uint256 proposalId, State state);
    error AlreadyExecuted(uint256 proposalId);
    error TooManyActions(uint256 supplied, uint256 maximum);
    error ActionDataTooLarge(uint256 actionIndex, uint256 supplied, uint256 maximum);
    error DescriptionTooLarge(uint256 supplied, uint256 maximum);
    error ZeroActionTarget(uint256 actionIndex);
    error ActionFailed(uint256 actionIndex, bytes reason);

    /// @notice Binds a clone to exactly one deed, runtime and VOID vote token.
    function initialise(
        uint256 tokenId_,
        IVoidChainAppRuntime runtime_,
        IVoidVotes voidToken_,
        IVoidChainDeed deed_
    ) external {
        if (tokenId != 0) revert AlreadyInitialised();
        if (tokenId_ == 0) revert NotInitialised();
        if (address(runtime_) == address(0) || address(voidToken_) == address(0) || address(deed_) == address(0)) {
            revert ZeroAddress();
        }
        tokenId = tokenId_;
        runtime = runtime_;
        voidToken = voidToken_;
        deed = deed_;
    }

    /// @notice The current deed holder may propose any zero-value, on-chain action.
    /// @dev Empty actions make a signalling proposal. This DAO intentionally does
    ///      not pre-screen subjects; authority is enforced by each target itself.
    ///      For example, the runtime accepts a configuration call only from the
    ///      DAO registered for the same `tokenId`, and protocol roles reject DAOs.
    function propose(Action[] calldata actions, string calldata description)
        external
        returns (uint256 proposalId)
    {
        if (tokenId == 0) revert NotInitialised();
        if (deed.ownerOf(tokenId) != msg.sender) revert NotDeedHolder(tokenId, msg.sender);
        if (actions.length > MAX_ACTIONS) revert TooManyActions(actions.length, MAX_ACTIONS);
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) {
            revert DescriptionTooLarge(bytes(description).length, MAX_DESCRIPTION_BYTES);
        }

        for (uint256 i; i < actions.length; ++i) {
            if (actions[i].target == address(0)) revert ZeroActionTarget(i);
            if (actions[i].data.length > MAX_ACTION_DATA_BYTES) {
                revert ActionDataTooLarge(i, actions[i].data.length, MAX_ACTION_DATA_BYTES);
            }
        }

        uint256 snapshotBlock = block.number - 1;
        uint256 snapshotSupply = voidToken.getPastTotalSupply(snapshotBlock);
        if (snapshotSupply == 0) revert EmptySnapshot();

        proposalId = ++proposalCount;
        uint256 deadline = block.timestamp + VOTING_PERIOD;
        bytes32 actionsHash = keccak256(abi.encode(actions));
        bytes32 descriptionHash = keccak256(bytes(description));
        proposals[proposalId] = Proposal({
            actionsHash: actionsHash,
            descriptionHash: descriptionHash,
            snapshotBlock: snapshotBlock,
            snapshotSupply: snapshotSupply,
            deadline: deadline,
            forVotes: 0,
            againstVotes: 0,
            actionCount: actions.length,
            executed: false
        });
        proposalOwnershipEpoch[proposalId] = deed.ownershipEpoch(tokenId);
        _descriptions[proposalId] = description;
        for (uint256 i; i < actions.length; ++i) _actions[proposalId].push(actions[i]);

        emit ProposalCreated(
            proposalId,
            msg.sender,
            actionsHash,
            actions.length,
            snapshotBlock,
            deadline
        );
    }

    /// @notice Votes with the VOID the caller held in their wallet at the snapshot.
    function castVote(uint256 proposalId, bool support) external {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert NoSuchProposal(proposalId);
        if (block.timestamp > p.deadline) revert VotingClosed(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        uint256 weight = voidToken.getPastVotes(msg.sender, p.snapshotBlock);
        if (weight == 0) revert NoVotingPower(proposalId, msg.sender);

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) return State.Pending;
        if (p.executed) return State.Executed;
        if (deed.ownershipEpoch(tokenId) != proposalOwnershipEpoch[proposalId]) return State.Defeated;
        if (block.timestamp <= p.deadline) return State.Active;

        uint256 turnout = p.forVotes + p.againstVotes;
        if (turnout < _portionCeil(p.snapshotSupply, QUORUM_BPS)) return State.Defeated;
        return p.forVotes > p.againstVotes ? State.Succeeded : State.Defeated;
    }

    /// @notice Anyone may execute every approved action after the five-day vote.
    /// @dev All calls carry zero ETH. Marking first makes execution one-shot even
    ///      if an approved target attempts to re-enter this DAO.
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted(proposalId);

        State current = state(proposalId);
        if (current != State.Succeeded) revert NotSucceeded(proposalId, current);

        p.executed = true;
        for (uint256 i; i < p.actionCount; ++i) {
            Action storage action = _actions[proposalId][i];
            (bool ok, bytes memory reason) = action.target.call(action.data);
            if (!ok) revert ActionFailed(i, reason);
            emit ActionExecuted(proposalId, i, action.target);
        }
        emit Executed(proposalId, p.actionsHash);
    }

    function proposalDescription(uint256 proposalId) external view returns (string memory) {
        if (proposals[proposalId].deadline == 0) revert NoSuchProposal(proposalId);
        return _descriptions[proposalId];
    }

    function proposalAction(uint256 proposalId, uint256 actionIndex)
        external
        view
        returns (address target, bytes memory data)
    {
        if (actionIndex >= proposals[proposalId].actionCount) revert NoSuchProposal(proposalId);
        Action storage action = _actions[proposalId][actionIndex];
        return (action.target, action.data);
    }

    function _portionCeil(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }
}
