// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IVoidChainAppRuntime {
    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external;
}

/// @title VoidChainDao
/// @notice The DAO every chain ships with. One contract, 1,111 electorates, each
///         one voting on the ceiling its own chain's toll may not exceed.
///
/// @dev    WHAT IT GOVERNS, AND WHY ONLY THAT.
///
///         The deed holder runs their chain: they set the toll, they open or
///         close publishing, they collect the revenue. That is the whole product
///         and the DAO does not touch it.
///
///         What the DAO decides is the CEILING the holder cannot price above.
///         Without one, somebody who builds on a chain is exposed to the owner
///         raising the toll after they have committed — the `maxToll` a payer
///         signs protects a single call, not a business built on top of the
///         chain. With one, the people holding the token that pays the tolls set
///         the outer bound, and the owner is free inside it.
///
///         One contract for all 1,111, scoped by `tokenId`, for the same reason
///         the runtime is one contract: deploying 1,111 copies would cost a
///         fortune to say the same thing 1,111 times.
///
///         HOW WEIGHT IS MEASURED, AND THE ASSUMPTION IT RESTS ON.
///
///         Weight is the VOID an address held at a block that had already passed
///         when the question was asked. That has to be a snapshot: voting on live
///         balance means voting, forwarding the tokens, and voting again from the
///         next address, forever.
///
///         VOID carries no balance history on-chain, so the snapshot is a Merkle
///         tree built off-chain from public state at a public block, of which
///         only the root is published here. A voter proves their balance when
///         they vote. The EVM cannot verify a past balance and therefore cannot
///         verify the root — what protects the vote is that anyone can rebuild
///         the tree from the same public data and compare, and `DISPUTE_WINDOW`
///         exists so they can do it before a single vote is counted.
///
///         That is the same guarantee off-chain voting has given DAOs for years.
///         It is stated here rather than assumed.
contract VoidChainDao {
    IVoidChainAppRuntime public immutable runtime;

    /// @notice Deeds in the collection. A proposal outside this range would name
    ///         a chain that cannot exist.
    uint256 public constant TOTAL_CHAINS = 1111;

    /// @notice How long a proposal stays open once voting starts.
    uint256 public constant VOTING_PERIOD = 5 days;

    /// @notice Time between publishing a snapshot and votes counting, during
    ///         which anyone can rebuild the tree and object.
    uint256 public constant DISPUTE_WINDOW = 2 days;

    /// @notice Share of the snapshot that has to vote for the result to stand.
    uint256 public constant QUORUM_BPS = 1_000; // 10%
    uint256 public constant BPS = 10_000;

    /// @notice What a proposer must prove they held, as a share of the snapshot.
    /// @dev    Proposing is open, and it has to be: a DAO that protects users
    ///         from the owner cannot let the owner be the only one who may ask.
    ///         The floor is what keeps it from being free to flood.
    uint256 public constant PROPOSAL_THRESHOLD_BPS = 100; // 1%

    enum State { Pending, Active, Defeated, Succeeded, Executed }

    struct Proposal {
        uint256 tokenId;
        uint256 ceilingUsd;
        bytes32 balanceRoot;
        uint256 snapshotBlock;
        uint256 snapshotSupply;
        uint256 votingOpensAt;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    mapping(uint256 proposalId => Proposal) public proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
    uint256 public proposalCount;

    event Proposed(
        uint256 indexed proposalId,
        uint256 indexed tokenId,
        address indexed proposer,
        uint256 ceilingUsd,
        uint256 snapshotBlock,
        bytes32 balanceRoot,
        uint256 snapshotSupply,
        uint256 votingOpensAt,
        uint256 deadline
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event Executed(uint256 indexed proposalId, uint256 indexed tokenId, uint256 ceilingUsd);

    error ZeroAddress();
    error NoSuchChain(uint256 tokenId);
    error SnapshotNotInPast(uint256 snapshotBlock);
    error EmptySnapshot();
    error BelowProposalThreshold(uint256 weight, uint256 required);
    error VotingNotOpen(uint256 proposalId, uint256 opensAt);
    error VotingClosed(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error InvalidProof(address voter, uint256 balance);
    error ZeroWeight(address voter);
    error NotSucceeded(uint256 proposalId, State state);
    error AlreadyExecuted(uint256 proposalId);

    constructor(IVoidChainAppRuntime runtime_) {
        if (address(runtime_) == address(0)) revert ZeroAddress();
        runtime = runtime_;
    }

    // ---------------------------------------------------------------------
    // Asking
    // ---------------------------------------------------------------------

    /// @notice Opens a proposal to set one chain's toll ceiling.
    ///
    /// @param  tokenId       The chain whose ceiling this decides.
    /// @param  ceilingUsd    The proposed ceiling, in dollars with 18 decimals.
    /// @param  snapshotBlock A block that has already happened. Balances there
    ///                       decide weight, so nobody can position themselves
    ///                       after reading the question.
    /// @param  balanceRoot   Merkle root over leaves `keccak256(voter, balance)`.
    /// @param  snapshotSupply Sum of every balance in the tree — the quorum base.
    /// @param  weight        The proposer's own balance in the tree.
    /// @param  proof         Proof of that balance.
    function propose(
        uint256 tokenId,
        uint256 ceilingUsd,
        uint256 snapshotBlock,
        bytes32 balanceRoot,
        uint256 snapshotSupply,
        uint256 weight,
        bytes32[] calldata proof
    ) external returns (uint256 proposalId) {
        if (tokenId == 0 || tokenId > TOTAL_CHAINS) revert NoSuchChain(tokenId);
        if (snapshotBlock >= block.number) revert SnapshotNotInPast(snapshotBlock);
        if (snapshotSupply == 0 || balanceRoot == bytes32(0)) revert EmptySnapshot();

        // The proposer proves their stake against the same root everyone else
        // will vote against. A threshold checked any other way would be a
        // threshold against a number the proposer chose.
        if (!_proves(balanceRoot, msg.sender, weight, proof)) {
            revert InvalidProof(msg.sender, weight);
        }
        uint256 required = (snapshotSupply * PROPOSAL_THRESHOLD_BPS) / BPS;
        if (weight < required) revert BelowProposalThreshold(weight, required);

        proposalId = ++proposalCount;
        uint256 opensAt = block.timestamp + DISPUTE_WINDOW;

        proposals[proposalId] = Proposal({
            tokenId: tokenId,
            ceilingUsd: ceilingUsd,
            balanceRoot: balanceRoot,
            snapshotBlock: snapshotBlock,
            snapshotSupply: snapshotSupply,
            votingOpensAt: opensAt,
            deadline: opensAt + VOTING_PERIOD,
            forVotes: 0,
            againstVotes: 0,
            executed: false
        });

        emit Proposed(
            proposalId, tokenId, msg.sender, ceilingUsd,
            snapshotBlock, balanceRoot, snapshotSupply, opensAt, opensAt + VOTING_PERIOD
        );
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /// @notice Votes with the balance held at the snapshot block.
    /// @dev    Nothing is transferred, locked or wrapped. The contract never
    ///         takes custody of a single wei, and moving the tokens afterwards
    ///         changes nothing — the new address held nothing at the snapshot.
    function castVote(
        uint256 proposalId,
        bool support,
        uint256 balance,
        bytes32[] calldata proof
    ) external {
        Proposal storage p = proposals[proposalId];
        if (block.timestamp < p.votingOpensAt) revert VotingNotOpen(proposalId, p.votingOpensAt);
        if (block.timestamp > p.deadline) revert VotingClosed(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);
        if (balance == 0) revert ZeroWeight(msg.sender);
        if (!_proves(p.balanceRoot, msg.sender, balance, proof)) {
            revert InvalidProof(msg.sender, balance);
        }

        hasVoted[proposalId][msg.sender] = true;
        if (support) p.forVotes += balance;
        else p.againstVotes += balance;

        emit VoteCast(proposalId, msg.sender, support, balance);
    }

    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) return State.Pending;
        if (p.executed) return State.Executed;
        if (block.timestamp < p.votingOpensAt) return State.Pending;
        if (block.timestamp <= p.deadline) return State.Active;

        uint256 turnout = p.forVotes + p.againstVotes;
        if (turnout < (p.snapshotSupply * QUORUM_BPS) / BPS) return State.Defeated;
        return p.forVotes > p.againstVotes ? State.Succeeded : State.Defeated;
    }

    // ---------------------------------------------------------------------
    // Executing
    // ---------------------------------------------------------------------

    /// @notice Applies a proposal that carried. Open to anyone.
    /// @dev    The outcome is already decided by the votes, and the action is
    ///         fixed in the proposal, so the caller chooses nothing — they only
    ///         pay the gas. Restricting it would let whoever holds that right
    ///         quietly bury a result they dislike.
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted(proposalId);

        State s = state(proposalId);
        if (s != State.Succeeded) revert NotSucceeded(proposalId, s);

        p.executed = true;
        runtime.setTollCeiling(p.tokenId, p.ceilingUsd);

        emit Executed(proposalId, p.tokenId, p.ceilingUsd);
    }

    /// @dev The leaf is hashed twice so a proof for an internal node cannot be
    ///      passed off as a proof for a leaf — the standard second-preimage
    ///      guard for Merkle trees over user-supplied data.
    function _proves(bytes32 root, address who, uint256 balance, bytes32[] calldata proof)
        private
        pure
        returns (bool)
    {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(who, balance))));
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }
}
