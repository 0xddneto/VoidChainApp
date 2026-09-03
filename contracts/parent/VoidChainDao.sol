// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVoidChainAppRuntime {
    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external;
}

/// @title VoidChainDao
/// @notice One chain's DAO. Its own address, storage and electorate.
///
/// @dev Votes are locked in this contract until a proposal closes. The
/// collection token does not promise ERC20Votes checkpoints, so an off-chain
/// Merkle "snapshot" could never be proven correct here. A dispute window
/// without an enforceable challenge would only look like security. Locking
/// makes every counted vote observable and prevents moving the same balance to
/// another address to vote again.
///
/// The DAO governs only the maximum toll. It cannot change an app, seize a
/// user's asset, or alter another chain's rules.
contract VoidChainDao is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant VOTING_PERIOD = 5 days;
    uint256 public constant QUORUM_BPS = 1_000; // 10%
    uint256 public constant BPS = 10_000;
    uint256 public constant PROPOSAL_THRESHOLD_BPS = 100; // 1%

    /// @notice The chain this DAO governs. Set once when its clone is born.
    uint256 public tokenId;
    IVoidChainAppRuntime public runtime;
    IERC20 public voidToken;

    enum State {
        Pending,
        Active,
        Defeated,
        Succeeded,
        Executed
    }

    struct Proposal {
        uint256 ceilingUsd;
        /// @notice Supply when the proposal opened, used only for quorum.
        uint256 supplyAtStart;
        uint256 deadline;
        uint256 forVotes;
        uint256 againstVotes;
        bool executed;
    }

    mapping(uint256 proposalId => Proposal) public proposals;
    mapping(uint256 proposalId => mapping(address voter => bool)) public hasVoted;
    /// @notice Tokens a voter may recover after that proposal closes.
    mapping(uint256 proposalId => mapping(address voter => uint256)) public lockedVotes;
    uint256 public proposalCount;

    event Proposed(
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 ceilingUsd,
        uint256 supplyAtStart,
        uint256 proposerWeight,
        uint256 deadline
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event VoteWithdrawn(uint256 indexed proposalId, address indexed voter, uint256 weight);
    event Executed(uint256 indexed proposalId, uint256 ceilingUsd);

    error AlreadyInitialised();
    error NotInitialised();
    error ZeroAddress();
    error EmptySupply();
    error BelowProposalThreshold(uint256 weight, uint256 required);
    error NoSuchProposal(uint256 proposalId);
    error VotingClosed(uint256 proposalId);
    error VotingStillOpen(uint256 proposalId, uint256 deadline);
    error AlreadyVoted(uint256 proposalId, address voter);
    error ZeroWeight(address voter);
    error NothingToWithdraw(uint256 proposalId, address voter);
    error NotSucceeded(uint256 proposalId, State state);
    error AlreadyExecuted(uint256 proposalId);

    /// @notice Binds a fresh clone to one chain and the token that pays its tolls.
    /// @dev The implementation itself is initialized with a non-collection id,
    ///      so nobody can claim the master copy.
    function initialise(uint256 tokenId_, IVoidChainAppRuntime runtime_, IERC20 voidToken_) external {
        if (tokenId != 0) revert AlreadyInitialised();
        if (tokenId_ == 0) revert NotInitialised();
        if (address(runtime_) == address(0) || address(voidToken_) == address(0)) revert ZeroAddress();
        tokenId = tokenId_;
        runtime = runtime_;
        voidToken = voidToken_;
    }

    // ---------------------------------------------------------------------
    // Asking and voting
    // ---------------------------------------------------------------------

    /// @notice Opens a proposal and casts/locks the proposer's supporting vote.
    /// @param ceilingUsd The proposed maximum toll, in USD with 18 decimals.
    /// @param weight VOID locked in support of the proposal until it closes.
    function propose(uint256 ceilingUsd, uint256 weight) external nonReentrant returns (uint256 proposalId) {
        if (tokenId == 0) revert NotInitialised();
        if (weight == 0) revert ZeroWeight(msg.sender);

        uint256 supply = voidToken.totalSupply();
        if (supply == 0) revert EmptySupply();
        // Round up: a one-token supply still needs one token to propose, rather
        // than turning a percentage threshold into zero.
        uint256 required = _portionCeil(supply, PROPOSAL_THRESHOLD_BPS);
        if (weight < required) revert BelowProposalThreshold(weight, required);

        voidToken.safeTransferFrom(msg.sender, address(this), weight);

        proposalId = ++proposalCount;
        uint256 deadline = block.timestamp + VOTING_PERIOD;
        proposals[proposalId] = Proposal({
            ceilingUsd: ceilingUsd,
            supplyAtStart: supply,
            deadline: deadline,
            forVotes: weight,
            againstVotes: 0,
            executed: false
        });
        hasVoted[proposalId][msg.sender] = true;
        lockedVotes[proposalId][msg.sender] = weight;

        emit Proposed(proposalId, msg.sender, ceilingUsd, supply, weight, deadline);
        emit VoteCast(proposalId, msg.sender, true, weight);
    }

    /// @notice Locks VOID and casts one vote on an open proposal.
    function castVote(uint256 proposalId, bool support, uint256 weight) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert NoSuchProposal(proposalId);
        if (block.timestamp > p.deadline) revert VotingClosed(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);
        if (weight == 0) revert ZeroWeight(msg.sender);

        voidToken.safeTransferFrom(msg.sender, address(this), weight);
        hasVoted[proposalId][msg.sender] = true;
        lockedVotes[proposalId][msg.sender] = weight;
        if (support) p.forVotes += weight;
        else p.againstVotes += weight;

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /// @notice Returns a voter's locked VOID after voting is over.
    function withdrawVote(uint256 proposalId) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) revert NoSuchProposal(proposalId);
        if (block.timestamp <= p.deadline) revert VotingStillOpen(proposalId, p.deadline);

        uint256 weight = lockedVotes[proposalId][msg.sender];
        if (weight == 0) revert NothingToWithdraw(proposalId, msg.sender);
        lockedVotes[proposalId][msg.sender] = 0;
        voidToken.safeTransfer(msg.sender, weight);

        emit VoteWithdrawn(proposalId, msg.sender, weight);
    }

    function state(uint256 proposalId) public view returns (State) {
        Proposal storage p = proposals[proposalId];
        if (p.deadline == 0) return State.Pending;
        if (p.executed) return State.Executed;
        if (block.timestamp <= p.deadline) return State.Active;

        uint256 turnout = p.forVotes + p.againstVotes;
        if (turnout < _portionCeil(p.supplyAtStart, QUORUM_BPS)) return State.Defeated;
        return p.forVotes > p.againstVotes ? State.Succeeded : State.Defeated;
    }

    // ---------------------------------------------------------------------
    // Executing
    // ---------------------------------------------------------------------

    /// @notice Applies a carried ceiling. Anyone may pay to execute it.
    function execute(uint256 proposalId) external {
        Proposal storage p = proposals[proposalId];
        if (p.executed) revert AlreadyExecuted(proposalId);

        State s = state(proposalId);
        if (s != State.Succeeded) revert NotSucceeded(proposalId, s);

        p.executed = true;
        runtime.setTollCeiling(tokenId, p.ceilingUsd);
        emit Executed(proposalId, p.ceilingUsd);
    }

    function _portionCeil(uint256 amount, uint256 bps) private pure returns (uint256) {
        return (amount * bps + BPS - 1) / BPS;
    }
}
