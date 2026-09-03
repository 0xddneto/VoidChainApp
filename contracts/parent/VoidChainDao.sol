// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVoidChainAppRuntime {
    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external;
}

interface IVoidChainDeed {
    function ownerOf(uint256 tokenId) external view returns (address);
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
    uint256 public constant QUORUM_BPS = 1_000; // 10%
    uint256 public constant BPS = 10_000;

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

    struct Proposal {
        uint256 feeLimitUsd;
        uint256 snapshotBlock;
        uint256 snapshotSupply;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    mapping(uint256 proposalId => Proposal) public proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
    uint256 public proposalCount;

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 feeLimitUsd,
        uint256 snapshotBlock,
        uint256 snapshotSupply,
        uint256 deadline
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event Executed(uint256 indexed proposalId, uint256 feeLimitUsd);

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

    /// @notice The current deed holder creates a proposal for this chain's fee limit.
    /// @dev The DAO can only constrain this one economic setting. It cannot take
    ///      assets, remove apps or affect any other chain.
    function propose(uint256 feeLimitUsd) external returns (uint256 proposalId) {
        if (tokenId == 0) revert NotInitialised();
        if (deed.ownerOf(tokenId) != msg.sender) revert NotDeedHolder(tokenId, msg.sender);

        uint256 snapshotBlock = block.number - 1;
        uint256 snapshotSupply = voidToken.getPastTotalSupply(snapshotBlock);
        if (snapshotSupply == 0) revert EmptySnapshot();

        proposalId = ++proposalCount;
        uint256 deadline = block.timestamp + VOTING_PERIOD;
        proposals[proposalId] = Proposal({
            feeLimitUsd: feeLimitUsd,
            snapshotBlock: snapshotBlock,
            snapshotSupply: snapshotSupply,
            deadline: deadline,
            forVotes: 0,
            againstVotes: 0,
            executed: false
        });

        emit ProposalCreated(proposalId, msg.sender, feeLimitUsd, snapshotBlock, snapshotSupply, deadline);
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
        if (block.timestamp <= p.deadline) return State.Active;

        uint256 turnout = p.forVotes + p.againstVotes;
        if (turnout < _portionCeil(p.snapshotSupply, QUORUM_BPS)) return State.Defeated;
        return p.forVotes > p.againstVotes ? State.Succeeded : State.Defeated;
    }

    /// @notice Anyone may apply a proposal that passed after the five-day vote.
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted(proposalId);

        State current = state(proposalId);
        if (current != State.Succeeded) revert NotSucceeded(proposalId, current);

        p.executed = true;
        runtime.setTollCeiling(tokenId, p.feeLimitUsd);
        emit Executed(proposalId, p.feeLimitUsd);
    }

    function _portionCeil(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }
}
