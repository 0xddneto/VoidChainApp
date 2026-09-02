// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainGovernor} from "../contracts/child/VoidChainGovernor.sol";

/**
 * The DAO under attack.
 *
 * The attack that matters: vote, move the tokens to another address and vote
 * again. That is why the weight comes from an instant in the past rather than
 * the current balance — and that is what these tests really verify.
 */
contract GovernorTest is Test {
    VoidChainGovernor gov;

    address executor = address(0xEEC);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address attacker = address(0xBAD);

    uint256 constant ALICE_BALANCE = 600 ether;
    uint256 constant BOB_BALANCE = 400 ether;
    uint256 constant SUPPLY = ALICE_BALANCE + BOB_BALANCE;

    bytes32 leafAlice;
    bytes32 leafBob;
    bytes32 root;

    bytes32 constant ACTION = keccak256("setMinBaseFee(1 gwei)");

    function setUp() public {
        gov = new VoidChainGovernor(executor);

        // A two-leaf tree: the root is the hash of the ordered pair.
        leafAlice = _leaf(alice, ALICE_BALANCE);
        leafBob = _leaf(bob, BOB_BALANCE);
        root = _hashPair(leafAlice, leafBob);

        vm.roll(100);
    }

    function _leaf(address voter, uint256 balance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(voter, balance))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _proofFor(bytes32 sibling) internal pure returns (bytes32[] memory) {
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = sibling;
        return proof;
    }

    function _propose() internal returns (uint256) {
        vm.prank(executor);
        return gov.propose(ACTION, block.number - 1, root, SUPPLY, "subir a taxa");
    }

    function _openVoting() internal {
        vm.warp(block.timestamp + gov.DISPUTE_WINDOW() + 1);
    }

    // -----------------------------------------------------------------------
    // The central attack: voting twice with the same money
    // -----------------------------------------------------------------------

    /// @notice Moving the tokens after the snapshot creates no new vote: the
    ///         destination address was not in the photograph, so it proves
    ///         nothing.
    function test_MovingTokensAfterSnapshotCreatesNoNewVote() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));

        // The attacker received Alice's tokens after the snapshot and tries to
        // vote. There is no leaf for them, and any proof they present fails.
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainGovernor.InvalidProof.selector, attacker, ALICE_BALANCE
            )
        );
        vm.prank(attacker);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
    }

    function test_SameAddressCannotVoteTwice() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainGovernor.AlreadyVoted.selector, id, alice)
        );
        vm.prank(alice);
        gov.castVote(id, false, ALICE_BALANCE, _proofFor(leafBob));
    }

    /// @notice Inflating your own weight requires a proof that does not exist.
    function test_CannotVoteWithInflatedBalance() public {
        uint256 id = _propose();
        _openVoting();

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainGovernor.InvalidProof.selector, alice, SUPPLY)
        );
        vm.prank(alice);
        gov.castVote(id, true, SUPPLY, _proofFor(leafBob));
    }

    // -----------------------------------------------------------------------
    // A janela
    // -----------------------------------------------------------------------

    function test_CannotVoteDuringDisputeWindow() public {
        uint256 id = _propose();

        vm.expectRevert();
        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
    }

    function test_CannotVoteAfterDeadline() public {
        uint256 id = _propose();
        _openVoting();
        vm.warp(block.timestamp + gov.VOTING_PERIOD() + 1);

        vm.expectRevert(abi.encodeWithSelector(VoidChainGovernor.VotingClosed.selector, id));
        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
    }

    /// @notice Voting lasts at least five days, by protocol rule.
    function test_VotingPeriodIsAtLeastFiveDays() public view {
        assertGe(gov.VOTING_PERIOD(), 5 days);
    }

    // -----------------------------------------------------------------------
    // Quorum and outcome
    // -----------------------------------------------------------------------

    /// @notice Turnout below quorum defeats the proposal even with every vote in
    ///         favor — otherwise one small wallet would be enough to decide.
    function test_BelowQuorumIsDefeatedEvenIfUnanimous() public {
        // A single tiny leaf: the declared electorate is large, but almost
        // nobody votes.
        bytes32 tiny = _leaf(alice, 1);
        bytes32 other = _leaf(bob, 1);
        bytes32 r = _hashPair(tiny, other);

        vm.prank(executor);
        uint256 id = gov.propose(ACTION, block.number - 1, r, 1_000_000 ether, "quorum baixo");
        _openVoting();

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = other;
        vm.prank(alice);
        gov.castVote(id, true, 1, proof);

        vm.warp(block.timestamp + gov.VOTING_PERIOD() + 1);
        assertEq(uint256(gov.state(id)), uint256(VoidChainGovernor.State.Defeated));
    }

    function test_MajorityWithQuorumSucceeds() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
        vm.prank(bob);
        gov.castVote(id, false, BOB_BALANCE, _proofFor(leafAlice));

        vm.warp(block.timestamp + gov.VOTING_PERIOD() + 1);
        assertEq(uint256(gov.state(id)), uint256(VoidChainGovernor.State.Succeeded));
    }

    // -----------------------------------------------------------------------
    // Who proposes and who cancels
    // -----------------------------------------------------------------------

    function test_OnlyExecutorProposes() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainGovernor.NotExecutor.selector, attacker)
        );
        vm.prank(attacker);
        gov.propose(ACTION, block.number - 1, root, SUPPLY, "ataque");
    }

    /// @notice The snapshot has to be in the past, otherwise one could pick a
    ///         future block and take a position after seeing the question.
    function test_SnapshotMustBeInThePast() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainGovernor.SnapshotNotInPast.selector, block.number)
        );
        vm.prank(executor);
        gov.propose(ACTION, block.number, root, SUPPLY, "snapshot futuro");
    }

    /// @notice Cancelling only works during the dispute window. Once the first
    ///         vote counts, being able to void the ballot would be being able to
    ///         ignore the result.
    function test_CannotCancelOnceVotingOpened() public {
        uint256 id = _propose();
        _openVoting();

        vm.expectRevert(
            abi.encodeWithSelector(VoidChainGovernor.DisputeWindowClosed.selector, id)
        );
        vm.prank(executor);
        gov.cancel(id, "mudei de ideia");
    }

    function test_CancelledProposalCannotBeVotedOn() public {
        uint256 id = _propose();

        vm.prank(executor);
        gov.cancel(id, "raiz errada");

        _openVoting();
        vm.expectRevert(abi.encodeWithSelector(VoidChainGovernor.VotingClosed.selector, id));
        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    /// @notice The action executed has to be exactly the one that was voted on.
    function test_ExecutedActionMustMatchWhatWasVoted() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));
        vm.warp(block.timestamp + gov.VOTING_PERIOD() + 1);

        bytes memory outra = abi.encodeWithSignature("applyMinBaseFee(uint256)", uint256(999));
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainGovernor.ActionMismatch.selector, ACTION, keccak256(outra)
            )
        );
        vm.prank(executor);
        gov.markExecuted(id, outra);
    }

    function test_DefeatedProposalCannotBeExecuted() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(bob);
        gov.castVote(id, false, BOB_BALANCE, _proofFor(leafAlice));
        vm.warp(block.timestamp + gov.VOTING_PERIOD() + 1);

        vm.expectRevert();
        vm.prank(executor);
        gov.markExecuted(id, abi.encode(ACTION));
    }

    /// @notice The DAO never takes custody of any token — there is no way to.
    function test_GovernorNeverHoldsFunds() public {
        uint256 id = _propose();
        _openVoting();
        vm.prank(alice);
        gov.castVote(id, true, ALICE_BALANCE, _proofFor(leafBob));

        assertEq(address(gov).balance, 0, "the DAO should hold custody of nothing");
    }
}
