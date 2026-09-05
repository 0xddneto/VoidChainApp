// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VoidChainDao, IVoidChainAppRuntime, IVoidChainDeed, IVoidVotes} from "../contracts/parent/VoidChainDao.sol";
import {VoidChainDaoFactory} from "../contracts/parent/VoidChainDaoFactory.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";

contract DeedSpy is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    mapping(uint256 => uint256) public ownershipEpoch;

    function setOwner(uint256 tokenId, address owner) external {
        if (owners[tokenId] != address(0) && owners[tokenId] != owner) ++ownershipEpoch[tokenId];
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

    error NotThisChainsDao(uint256 tokenId, address caller);

    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external {
        if (msg.sender != daoOf[tokenId]) revert NotThisChainsDao(tokenId, msg.sender);
        ceilingOf[tokenId] = ceilingUsd;
        wasSet[tokenId] = true;
    }

    function registerDao(uint256 tokenId, address dao) external {
        daoOf[tokenId] = dao;
    }
}

contract ProposalTarget {
    uint256 public value;

    function setValue(uint256 next) external {
        value = next;
    }
}

/// @notice The DAO's essential invariant: voting never takes custody of VOID.
contract DaoTest is Test {
    VoidChainDaoFactory factory;
    VoidChainDao dao;
    RuntimeSpy runtime;
    VoidTestToken token;
    DeedSpy deed;
    ProposalTarget target;

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
        target = new ProposalTarget();
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

    function _feeActions(uint256 chain, uint256 fee)
        internal
        view
        returns (VoidChainDao.Action[] memory actions)
    {
        actions = new VoidChainDao.Action[](1);
        actions[0] = VoidChainDao.Action({
            target: address(runtime),
            data: abi.encodeCall(IVoidChainAppRuntime.setTollCeiling, (chain, fee))
        });
    }

    function _propose() internal returns (uint256 id) {
        VoidChainDao.Action[] memory actions = _feeActions(CHAIN, FEE_LIMIT);
        vm.prank(holder);
        id = dao.propose(actions, "Set a transaction fee limit");
    }

    function _vote(uint256 id, address voter, bool support) internal {
        vm.prank(voter);
        dao.castVote(id, support);
    }

    function _closeVoting() internal {
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
    }

    function test_OnlyTheDeedHolderCreatesAProposal() public {
        VoidChainDao.Action[] memory actions = _feeActions(CHAIN, FEE_LIMIT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.NotDeedHolder.selector, CHAIN, alice));
        dao.propose(actions, "Not allowed");
    }

    function test_ProposalOpensForExactlyFiveDays() public {
        uint256 id = _propose();
        (, , , , uint256 deadline, , , , ) = dao.proposals(id);
        assertEq(deadline, block.timestamp + 5 days);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Active));
    }

    function test_DeedTransferInvalidatesSellerProposal() public {
        uint256 id = _propose();
        deed.setOwner(CHAIN, bob);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
    }

    function test_WalletVotingNeverLocksOrMovesVoid() public {
        uint256 id = _propose();
        uint256 before = token.balanceOf(alice);
        _vote(id, alice, true);

        assertEq(token.balanceOf(alice), before, "VOID left the voter's wallet");
        assertEq(token.balanceOf(address(dao)), 0, "DAO held VOID");
    }

    function test_WalletBalanceAtSnapshotIsTheVoteWeight() public {
        uint256 id = _propose();
        (, , uint256 snapshotBlock, , , , , , ) = dao.proposals(id);
        _vote(id, alice, true);
        (, , , , , uint256 forVotes, , , ) = dao.proposals(id);

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

    function test_ApprovedProposalCanConfigureOnlyItsOwnChain() public {
        uint256 id = _propose();
        _vote(id, alice, true);
        _closeVoting();
        dao.execute(id);

        assertEq(runtime.ceilingOf(CHAIN), FEE_LIMIT);
        assertTrue(runtime.wasSet(CHAIN));
        assertFalse(runtime.wasSet(CHAIN + 1));
    }

    function test_HolderCanProposeAnyOnChainAction() public {
        VoidChainDao.Action[] memory actions = new VoidChainDao.Action[](1);
        actions[0] = VoidChainDao.Action({
            target: address(target), data: abi.encodeCall(ProposalTarget.setValue, (42))
        });
        vm.prank(holder);
        uint256 id = dao.propose(actions, "Set the community target to 42");

        assertEq(dao.proposalDescription(id), "Set the community target to 42");
        (address actionTarget, bytes memory actionData) = dao.proposalAction(id, 0);
        assertEq(actionTarget, address(target));
        assertEq(actionData, abi.encodeCall(ProposalTarget.setValue, (42)));

        _vote(id, alice, true);
        _closeVoting();
        dao.execute(id);
        assertEq(target.value(), 42);
    }

    function test_HolderCanCreateASignalProposalWithoutActions() public {
        VoidChainDao.Action[] memory actions = new VoidChainDao.Action[](0);
        vm.prank(holder);
        uint256 id = dao.propose(actions, "Should this chain fund a grants round?");

        (, , , , , , , uint256 actionCount, ) = dao.proposals(id);
        assertEq(actionCount, 0);
        _vote(id, alice, true);
        _closeVoting();
        dao.execute(id);
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Executed));
    }

    function test_DaoCannotExecuteAnotherChainsRuntimeAction() public {
        deed.setOwner(CHAIN + 1, holder);
        factory.create(CHAIN + 1);
        VoidChainDao.Action[] memory actions = _feeActions(CHAIN + 1, FEE_LIMIT);
        vm.prank(holder);
        uint256 id = dao.propose(actions, "Try to change another chain");
        _vote(id, alice, true);
        _closeVoting();

        vm.expectRevert();
        dao.execute(id);
        assertFalse(runtime.wasSet(CHAIN + 1));
    }

    function test_BelowQuorumIsDefeated() public {
        token.mintTo(carol, 99_000 ether);
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
