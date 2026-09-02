// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title VoidChainGovernor
/// @notice The DAO of a single VOID Chain. One instance per chain, deployed on
///         that chain itself. You vote with the VOID sitting in your wallet --
///         nothing is staked, nothing is locked, nothing is wrapped.
///
/// @dev    THE PROBLEM THIS CONTRACT HAD TO SOLVE
///
///         The rule is: weight equals the VOID you hold on this chain, in your own
///         wallet, with no lock-up. That rule is harder to implement than it
///         sounds, because VOID is this chain's *native* currency.
///
///         Native balances have no on-chain history. Solidity can read
///         `address.balance` right now, but there is no `balanceOfAt(addr, block)`
///         the way an ERC-20 with checkpoints provides. Voting on live balance is
///         therefore fatal: vote with 1000 VOID, send it to a fresh address, vote
///         again, repeat. One balance becomes unlimited votes, and the DAO means
///         nothing.
///
///         THE FIX: MERKLE SNAPSHOT, NO CUSTODY
///
///         A proposal fixes a past block. Balances at that block are read off-chain
///         (`eth_getBalance` against an archive node is exact and public), hashed
///         into a Merkle tree, and only the 32-byte root is published on-chain.
///         A voter proves their balance with a Merkle proof at voting time.
///
///         The result: weight is your wallet balance at a moment that had already
///         passed when the question was asked. Moving VOID afterwards changes
///         nothing -- the second address holds nothing at the snapshot block, so it
///         proves nothing. No deposit, no lock, no stake, no wrapped token, and the
///         contract never takes custody of a single wei.
///
///         TRUST ASSUMPTION, STATED PLAINLY
///
///         The EVM cannot verify a past-block balance, so it cannot verify the root.
///         What protects the vote is reproducibility: the input is public chain
///         state at a public block, so anyone can rebuild the tree and check the
///         root byte for byte. A forged root is detectable by every observer, and
///         `disputeWindow` exists so it is detectable *before* the vote is counted.
///         This is the same guarantee off-chain voting infrastructure has offered
///         DAOs for years, made explicit rather than assumed.
///
///         A chain owner who wants stronger guarantees -- or a lock-up model with
///         its own reward scheme -- is free to deploy their own governor and point
///         the chain at it. This contract is the default, not a cage.
contract VoidChainGovernor {
    /// @notice Minimum time a proposal stays open, per protocol rule.
    uint256 public constant VOTING_PERIOD = 5 days;

    /// @notice Time between publishing a snapshot root and votes being counted,
    ///         during which observers can rebuild the tree and cry foul.
    uint256 public constant DISPUTE_WINDOW = 2 days;

    /// @notice Share of snapshot supply that must participate to be valid.
    uint256 public constant QUORUM_BPS = 1000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice The chain administrator, mirrored from the parent chain by
    ///         `VoidChainExecutor`. May open proposals and cancel disputed ones.
    address public immutable executor;

    enum State {
        None,
        Disputable,
        Active,
        Cancelled,
        Defeated,
        Succeeded,
        Executed
    }

    struct Proposal {
        uint256 snapshotBlock;
        bytes32 balanceRoot;
        /// @notice Total VOID across all leaves, the quorum denominator.
        uint256 snapshotSupply;
        uint256 votingOpensAt;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        bytes32 actionHash;
        string description;
        bool executed;
        bool cancelled;
    }

    mapping(uint256 proposalId => Proposal) public proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
    uint256 public proposalCount;

    event ProposalCreated(
        uint256 indexed proposalId,
        bytes32 actionHash,
        uint256 snapshotBlock,
        bytes32 balanceRoot,
        uint256 snapshotSupply,
        uint256 votingOpensAt,
        uint256 deadline,
        string description
    );
    event ProposalCancelled(uint256 indexed proposalId, string reason);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId);

    error NotExecutor(address caller);
    error SnapshotNotInPast(uint256 snapshotBlock);
    error EmptySnapshot();
    error VotingNotOpen(uint256 proposalId, uint256 opensAt);
    error VotingClosed(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error InvalidProof(address voter, uint256 balance);
    error ZeroWeight(address voter);
    error ProposalNotSucceeded(uint256 proposalId, State state);
    error AlreadyExecuted(uint256 proposalId);
    error AlreadyCancelled(uint256 proposalId);
    error DisputeWindowClosed(uint256 proposalId);
    error ActionMismatch(bytes32 expected, bytes32 provided);

    error ZeroAddress();

    constructor(address executor_) {
        // Immutable: zero here would leave the DAO with nobody authorized to propose.
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor(msg.sender);
        _;
    }

    // ---------------------------------------------------------------------
    // Proposals
    // ---------------------------------------------------------------------

    /// @notice Opens a proposal against a balance snapshot already in the past.
    /// @param  snapshotBlock Block whose balances decide weight. Must already have
    ///         happened, so nobody can position themselves after seeing the
    ///         question.
    /// @param  balanceRoot Merkle root over leaves `keccak256(voter, balance)`.
    /// @param  snapshotSupply Sum of every balance in the tree, the quorum base.
    function propose(
        bytes32 actionHash,
        uint256 snapshotBlock,
        bytes32 balanceRoot,
        uint256 snapshotSupply,
        string calldata description
    ) external onlyExecutor returns (uint256 proposalId) {
        if (snapshotBlock >= block.number) revert SnapshotNotInPast(snapshotBlock);
        if (balanceRoot == bytes32(0) || snapshotSupply == 0) revert EmptySnapshot();

        proposalId = ++proposalCount;
        uint256 votingOpensAt = block.timestamp + DISPUTE_WINDOW;
        uint256 deadline = votingOpensAt + VOTING_PERIOD;

        proposals[proposalId] = Proposal({
            snapshotBlock: snapshotBlock,
            balanceRoot: balanceRoot,
            snapshotSupply: snapshotSupply,
            votingOpensAt: votingOpensAt,
            deadline: deadline,
            forVotes: 0,
            againstVotes: 0,
            actionHash: actionHash,
            description: description,
            executed: false,
            cancelled: false
        });

        emit ProposalCreated(
            proposalId,
            actionHash,
            snapshotBlock,
            balanceRoot,
            snapshotSupply,
            votingOpensAt,
            deadline,
            description
        );
    }

    /// @notice Cancels a proposal whose snapshot root was shown to be wrong.
    /// @dev    Only during the dispute window, and only before any vote counts.
    ///         Deliberately not available afterwards: the power to void a vote
    ///         mid-count is the power to ignore a result you dislike.
    function cancel(uint256 proposalId, string calldata reason) external onlyExecutor {
        Proposal storage p = proposals[proposalId];
        if (p.cancelled) revert AlreadyCancelled(proposalId);
        if (p.executed) revert AlreadyExecuted(proposalId);
        if (block.timestamp >= p.votingOpensAt) revert DisputeWindowClosed(proposalId);

        p.cancelled = true;
        emit ProposalCancelled(proposalId, reason);
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// @notice Votes with the VOID held at the snapshot block.
    /// @param  balance The voter's VOID balance at `snapshotBlock`.
    /// @param  proof Merkle proof of `keccak256(msg.sender, balance)`.
    function castVote(uint256 proposalId, bool support, uint256 balance, bytes32[] calldata proof)
        external
    {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0 || p.cancelled) revert VotingClosed(proposalId);
        if (block.timestamp < p.votingOpensAt) revert VotingNotOpen(proposalId, p.votingOpensAt);
        if (block.timestamp > p.deadline) revert VotingClosed(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);
        if (balance == 0) revert ZeroWeight(msg.sender);

        // Double hashing guards against second-preimage attacks on the tree.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, balance))));
        if (!MerkleProof.verifyCalldata(proof, p.balanceRoot, leaf)) {
            revert InvalidProof(msg.sender, balance);
        }

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += balance;
        else p.againstVotes += balance;

        emit VoteCast(proposalId, msg.sender, support, balance);
    }

    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) return State.None;
        if (p.cancelled) return State.Cancelled;
        if (p.executed) return State.Executed;
        if (block.timestamp < p.votingOpensAt) return State.Disputable;
        if (block.timestamp <= p.deadline) return State.Active;

        uint256 turnout = p.forVotes + p.againstVotes;
        uint256 quorum = (p.snapshotSupply * QUORUM_BPS) / BPS_DENOMINATOR;

        if (turnout < quorum) return State.Defeated;
        return p.forVotes > p.againstVotes ? State.Succeeded : State.Defeated;
    }

    /// @notice Confirms a passed proposal and the exact call it authorised.
    function markExecuted(uint256 proposalId, bytes calldata action) external onlyExecutor {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted(proposalId);

        State current = state(proposalId);
        if (current != State.Succeeded) revert ProposalNotSucceeded(proposalId, current);

        bytes32 provided = keccak256(action);
        if (provided != p.actionHash) revert ActionMismatch(p.actionHash, provided);

        p.executed = true;
        emit ProposalExecuted(proposalId);
    }
}
