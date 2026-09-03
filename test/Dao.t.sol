// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDao, IVoidChainAppRuntime, IVoidChainDeed, IVoidVotes} from "../contracts/parent/VoidChainDao.sol";
import {VoidChainDaoFactory} from "../contracts/parent/VoidChainDaoFactory.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";

contract DeedSpy is IVoidChainDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract RuntimeSpy is IVoidChainAppRuntime {
    mapping(uint256 => uint256) public ceilingOf;
    mapping(uint256 => bool) public wasSet;
    mapping(uint256 => address) public daoOf;

    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external {
        ceilingOf[tokenId] = ceilingUsd;
        wasSet[tokenId] = true;
    }

    function registerDao(uint256 tokenId, address dao) external {
        daoOf[tokenId] = dao;
    }
}

/// @notice The DAO's essential invariant: voting never takes custody of VOID.
contract DaoTest is Test {
    VoidChainDaoFactory factory;
    VoidChainDao dao;
    RuntimeSpy runtime;
    VoidTestToken token;
    DeedSpy deed;

    address holder = address(0xD33D);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant ALICE = 600 ether;
    uint256 constant BOB = 400 ether;
    uint256 constant CHAIN = 7;
    uint256 constant FEE_LIMIT = 0.05 ether; // $0.05

    function setUp() public {
        runtime = new RuntimeSpy();
        token = new VoidTestToken();
        deed = new DeedSpy();
        deed.setOwner(CHAIN, holder);
        token.mintTo(alice, ALICE);
        token.mintTo(bob, BOB);
        vm.roll(block.number + 1);

        factory = new VoidChainDaoFactory(
            IVoidChainAppRuntime(address(runtime)), IVoidVotes(address(token)), IVoidChainDeed(address(deed))
        );
        dao = VoidChainDao(factory.create(CHAIN));
        vm.warp(1_000_000);
    }

    function _propose() internal returns (uint256 id) {
        vm.prank(holder);
        id = dao.propose(FEE_LIMIT);
    }

    function _vote(uint256 id, address voter, bool support) internal {
        vm.prank(voter);
        dao.castVote(id, support);
    }

    function _closeVoting() internal {
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
    }

    function test_OnlyTheDeedHolderCreatesAProposal() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.NotDeedHolder.selector, CHAIN, alice));
        dao.propose(FEE_LIMIT);
    }

    function test_ProposalOpensForExactlyFiveDays() public {
        uint256 id = _propose();
        (, , , uint256 deadline, , , ) = dao.proposals(id);
        assertEq(deadline, block.timestamp + 5 days);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Active));
    }

    function test_VotingNeverLocksOrMovesVoid() public {
        uint256 id = _propose();
        uint256 before = token.balanceOf(alice);
        _vote(id, alice, true);

        assertEq(token.balanceOf(alice), before, "VOID left the voter's wallet");
        assertEq(token.balanceOf(address(dao)), 0, "DAO held VOID");
    }

    function test_WalletBalanceAtSnapshotIsTheVoteWeight() public {
        uint256 id = _propose();
        (, uint256 snapshotBlock, , , , , ) = dao.proposals(id);
        _vote(id, alice, true);
        (, , , , uint256 forVotes, , ) = dao.proposals(id);

        assertEq(forVotes, ALICE);
        assertEq(token.getPastVotes(alice, snapshotBlock), ALICE);
    }

    function test_TransferredVoidCannotVoteTwice() public {
        uint256 id = _propose();
        vm.prank(alice);
        token.transfer(carol, ALICE);

        // Alice owned the VOID in the snapshot and remains able to vote. Carol
        // received it later and has zero voting power for this proposal.
        _vote(id, alice, true);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.NoVotingPower.selector, id, carol));
        dao.castVote(id, true);
    }

    function test_WalletMaySpendItsVoidAfterTheSnapshot() public {
        uint256 id = _propose();
        vm.prank(alice);
        token.transfer(carol, ALICE);
        _vote(id, alice, true);

        assertEq(token.balanceOf(alice), 0, "the wallet could not spend its VOID");
        assertEq(token.balanceOf(carol), ALICE);
    }

    function test_CannotVoteTwiceOnOneProposal() public {
        uint256 id = _propose();
        _vote(id, alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.AlreadyVoted.selector, id, alice));
        dao.castVote(id, true);
    }

    function test_CarriedProposalSetsOnlyThisChainsFeeLimit() public {
        uint256 id = _propose();
        _vote(id, alice, true);
        _closeVoting();
        dao.execute(id);

        assertEq(runtime.ceilingOf(CHAIN), FEE_LIMIT);
        assertTrue(runtime.wasSet(CHAIN));
        assertFalse(runtime.wasSet(CHAIN + 1));
    }

    function test_BelowQuorumIsDefeated() public {
        token.mintTo(carol, 9_000 ether);
        vm.roll(block.number + 1);
        uint256 id = _propose();
        _vote(id, alice, true);
        _closeVoting();

        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
    }

    function test_MoreAgainstThanForIsDefeated() public {
        token.mintTo(bob, 300 ether);
        vm.roll(block.number + 1);
        uint256 id = _propose();
        _vote(id, alice, true);
        _vote(id, bob, false);
        _closeVoting();

        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
    }

    function test_AnyoneCanExecuteAPassedProposal() public {
        uint256 id = _propose();
        _vote(id, alice, true);
        _closeVoting();

        vm.prank(address(0xDEADBEEF));
        dao.execute(id);
        assertEq(runtime.ceilingOf(CHAIN), FEE_LIMIT);
    }

    function test_EveryChainGetsItsOwnDao() public {
        deed.setOwner(CHAIN + 1, holder);
        address other = factory.create(CHAIN + 1);
        assertTrue(other != address(dao));
        assertEq(VoidChainDao(other).tokenId(), CHAIN + 1);
        assertEq(runtime.daoOf(CHAIN + 1), other);
    }

    function test_FactoryStillRejectsChainOutsideTheCollection() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainDaoFactory.NoSuchChain.selector, uint256(1112)));
        factory.create(1112);
    }
}
