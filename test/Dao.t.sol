// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDao, IVoidChainAppRuntime} from "../contracts/parent/VoidChainDao.sol";

/// @notice Records what the DAO told it, so the test can see the effect without
///         standing up the whole runtime.
contract RuntimeSpy is IVoidChainAppRuntime {
    mapping(uint256 => uint256) public ceilingOf;
    mapping(uint256 => bool) public wasSet;
    address public lastCaller;

    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external {
        ceilingOf[tokenId] = ceilingUsd;
        wasSet[tokenId] = true;
        lastCaller = msg.sender;
    }
}

/**
 * The DAO every chain ships with, under attack.
 *
 * The attack that decides whether this contract means anything: vote, move the
 * tokens to a fresh address, vote again. That is why weight comes from a block
 * already in the past, and it is the first thing tested here.
 *
 * The second is the boundary the DAO must not cross. It sets what a chain may
 * charge at most; it does not run the chain, and it must not be able to reach a
 * chain it was not asked about.
 */
contract DaoTest is Test {
    VoidChainDao dao;
    RuntimeSpy runtime;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant ALICE = 600 ether;
    uint256 constant BOB = 400 ether;
    uint256 constant SUPPLY = ALICE + BOB;

    uint256 constant CHAIN = 7;
    uint256 constant CEILING = 0.05 ether; // $0.05 per call

    bytes32 leafAlice;
    bytes32 leafBob;
    bytes32 root;

    function setUp() public {
        runtime = new RuntimeSpy();
        dao = new VoidChainDao(IVoidChainAppRuntime(address(runtime)));

        leafAlice = _leaf(alice, ALICE);
        leafBob = _leaf(bob, BOB);
        root = _hashPair(leafAlice, leafBob);

        vm.roll(100);
        vm.warp(1_000_000);
    }

    function _leaf(address voter, uint256 balance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(voter, balance))));
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function _proofFor(bytes32 sibling) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = sibling;
    }

    /// @dev Alice clears the 1% threshold on her own, so she is the proposer in
    ///      every case that is not about proposing.
    function _propose() internal returns (uint256 id) {
        vm.prank(alice);
        id = dao.propose(CHAIN, CEILING, 99, root, SUPPLY, ALICE, _proofFor(leafBob));
    }

    function _openVoting() internal {
        vm.warp(block.timestamp + dao.DISPUTE_WINDOW() + 1);
    }

    // -----------------------------------------------------------------------
    // The attack the snapshot exists to stop
    // -----------------------------------------------------------------------

    /// @notice Moving the tokens after the snapshot creates no new vote: the new
    ///         address held nothing at that block, so it can prove nothing.
    function test_MovingTokensAfterTheSnapshotProvesNothing() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));

        // Carol now holds Alice's tokens. There is no leaf for her, and any
        // proof she presents fails.
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.InvalidProof.selector, carol, ALICE));
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
    }

    /// @notice Inflating your own weight requires a proof that does not exist.
    function test_CannotVoteWithMoreThanTheSnapshotSays() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.InvalidProof.selector, bob, ALICE));
        dao.castVote(id, true, ALICE, _proofFor(leafAlice));
    }

    /// @notice One address, one vote per proposal.
    function test_CannotVoteTwice() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.AlreadyVoted.selector, id, alice));
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
    }

    // -----------------------------------------------------------------------
    // The windows
    // -----------------------------------------------------------------------

    /// @notice Nothing counts until the dispute window closes — that window is
    ///         what makes a forged root detectable before it decides anything.
    function test_VotingIsClosedDuringTheDisputeWindow() public {
        uint256 id = _propose();

        vm.prank(alice);
        vm.expectRevert();
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
    }

    function test_VotingClosesAtTheDeadline() public {
        uint256 id = _propose();
        _openVoting();
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.VotingClosed.selector, id));
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
    }

    /// @notice The snapshot has to be in the past, or a proposer could pick a
    ///         future block and position themselves after asking the question.
    function test_SnapshotMustAlreadyHaveHappened() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDao.SnapshotNotInPast.selector, block.number)
        );
        dao.propose(CHAIN, CEILING, block.number, root, SUPPLY, ALICE, _proofFor(leafBob));
    }

    // -----------------------------------------------------------------------
    // Who may ask
    // -----------------------------------------------------------------------

    /// @notice Proposing is open, but not free: below the threshold it is refused.
    function test_ProposingBelowTheThresholdIsRefused() public {
        // A tree where the proposer holds a dust balance against a large supply.
        uint256 dust = 1 ether;
        uint256 hugeSupply = 1_000_000 ether;
        bytes32 dustLeaf = _leaf(carol, dust);
        bytes32 otherLeaf = _leaf(bob, hugeSupply - dust);
        bytes32 dustRoot = _hashPair(dustLeaf, otherLeaf);

        // The expected value is computed BEFORE the prank. Reading a constant
        // from the contract is an external call, and an external call evaluated
        // as an argument consumes the prank — the proposer would be this test
        // contract, and the revert would name the wrong address.
        uint256 required = (hugeSupply * dao.PROPOSAL_THRESHOLD_BPS()) / dao.BPS();
        bytes memory expected = abi.encodeWithSelector(
            VoidChainDao.BelowProposalThreshold.selector, dust, required
        );

        vm.prank(carol);
        vm.expectRevert(expected);
        dao.propose(CHAIN, CEILING, 99, dustRoot, hugeSupply, dust, _proofFor(otherLeaf));
    }

    /// @notice The threshold is checked against the same root everyone votes on,
    ///         so a proposer cannot claim a stake the tree does not carry.
    function test_ProposerMustProveTheirOwnStake() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.InvalidProof.selector, carol, ALICE));
        dao.propose(CHAIN, CEILING, 99, root, SUPPLY, ALICE, _proofFor(leafBob));
    }

    /// @notice A chain outside the collection cannot be proposed against.
    function test_NoSuchChainIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.NoSuchChain.selector, uint256(1112)));
        dao.propose(1112, CEILING, 99, root, SUPPLY, ALICE, _proofFor(leafBob));
    }

    // -----------------------------------------------------------------------
    // Quorum and outcome
    // -----------------------------------------------------------------------

    /// @notice A proposal that carries sets the ceiling on the chain it named,
    ///         and on no other.
    function test_CarriedProposalSetsTheCeilingOnItsOwnChain() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));

        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Succeeded));

        dao.execute(id);

        assertEq(runtime.ceilingOf(CHAIN), CEILING, "the ceiling was not applied");
        assertTrue(runtime.wasSet(CHAIN), "the chain was not touched");
        assertFalse(runtime.wasSet(CHAIN + 1), "a chain nobody voted on was touched");
    }

    /// @notice Turnout below quorum defeats it even with every vote in favour.
    function test_BelowQuorumIsDefeated() public {
        // Alice has to clear the 1% needed to propose while falling short of the
        // 10% needed for quorum, so the supply sits between the two: her 600 is
        // well over 1% of 10,000 and well under 10% of it.
        uint256 wideSupply = 10_000 ether;
        bytes32 aLeaf = _leaf(alice, ALICE);
        bytes32 bLeaf = _leaf(bob, wideSupply - ALICE);
        bytes32 r = _hashPair(aLeaf, bLeaf);

        vm.prank(alice);
        uint256 id = dao.propose(CHAIN, CEILING, 99, r, wideSupply, ALICE, _proofFor(bLeaf));
        _openVoting();

        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(bLeaf));

        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));

        vm.expectRevert();
        dao.execute(id);
        assertFalse(runtime.wasSet(CHAIN), "a defeated proposal reached the runtime");
    }

    /// @notice More against than for is defeated, quorum or not.
    function test_MoreAgainstThanForIsDefeated() public {
        uint256 id = _propose();
        _openVoting();

        vm.prank(bob);
        dao.castVote(id, false, BOB, _proofFor(leafAlice));

        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
    }

    /// @notice Executing twice applies once.
    function test_CannotExecuteTwice() public {
        uint256 id = _propose();
        _openVoting();
        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);

        dao.execute(id);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.AlreadyExecuted.selector, id));
        dao.execute(id);
    }

    /// @notice Anyone may push a result through. The outcome is already decided
    ///         and the action is fixed, so the caller only pays the gas —
    ///         restricting it would let somebody bury a result they disliked.
    function test_AnyoneCanExecuteACarriedProposal() public {
        uint256 id = _propose();
        _openVoting();
        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);

        vm.prank(address(0xDEADBEEF));
        dao.execute(id);
        assertEq(runtime.ceilingOf(CHAIN), CEILING);
    }

    /// @notice The DAO never takes custody of anything.
    function test_TheDaoHoldsNothing() public {
        uint256 id = _propose();
        _openVoting();
        vm.prank(alice);
        dao.castVote(id, true, ALICE, _proofFor(leafBob));
        assertEq(address(dao).balance, 0, "the DAO should hold nothing");
    }
}
