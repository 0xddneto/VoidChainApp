// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VoidChainDao, IVoidChainAppRuntime} from "../contracts/parent/VoidChainDao.sol";
import {VoidChainDaoFactory} from "../contracts/parent/VoidChainDaoFactory.sol";

/// @notice Standard ERC-20 behavior is all the DAO requires. In particular,
///         it does not rely on an off-chain balance root or ERC20Votes hooks.
contract DaoToken is IERC20 {
    string public constant name = "Void governance test token";
    string public constant symbol = "VOTE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Records what a DAO told it, so the test can see the effect without
///         standing up the whole runtime. It also plays the factory registry.
contract RuntimeSpy is IVoidChainAppRuntime {
    mapping(uint256 => uint256) public ceilingOf;
    mapping(uint256 => bool) public wasSet;
    mapping(uint256 => address) public daoOf;
    address public lastCaller;

    function setTollCeiling(uint256 tokenId, uint256 ceilingUsd) external {
        ceilingOf[tokenId] = ceilingUsd;
        wasSet[tokenId] = true;
        lastCaller = msg.sender;
    }

    function registerDao(uint256 tokenId, address dao) external {
        daoOf[tokenId] = dao;
    }
}

/// @notice The chain DAO under the attacks that matter to vote accounting.
contract DaoTest is Test {
    VoidChainDaoFactory factory;
    VoidChainDao dao;
    RuntimeSpy runtime;
    DaoToken token;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    uint256 constant ALICE = 600 ether;
    uint256 constant BOB = 400 ether;
    uint256 constant CHAIN = 7;
    uint256 constant CEILING = 0.05 ether; // $0.05 per call

    function setUp() public {
        runtime = new RuntimeSpy();
        token = new DaoToken();
        token.mint(alice, ALICE);
        token.mint(bob, BOB);
        factory = new VoidChainDaoFactory(IVoidChainAppRuntime(address(runtime)), IERC20(address(token)));
        dao = VoidChainDao(factory.create(CHAIN));
        vm.warp(1_000_000);
    }

    function _approve(address voter, uint256 amount) internal {
        vm.prank(voter);
        token.approve(address(dao), amount);
    }

    function _propose() internal returns (uint256 id) {
        _approve(alice, ALICE);
        vm.prank(alice);
        id = dao.propose(CEILING, ALICE);
    }

    function _closeVoting() internal {
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
    }

    // -----------------------------------------------------------------------
    // Locked voting: no synthetic, unverifiable snapshots
    // -----------------------------------------------------------------------

    function test_ProposingLocksTheVotersActualTokens() public {
        uint256 id = _propose();

        assertEq(token.balanceOf(alice), 0, "the proposer still holds the locked vote");
        assertEq(token.balanceOf(address(dao)), ALICE, "the DAO did not receive the vote");
        assertEq(dao.lockedVotes(id, alice), ALICE, "the vote is not recoverable by Alice");
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Active), "the proposal is not live");
    }

    /// @notice A balance can only appear in one place while it is counted. Alice
    ///         cannot move the tokens to Carol and use them again in this vote.
    function test_LockedVoteCannotBeMovedToVoteAgain() public {
        uint256 id = _propose();

        vm.prank(carol);
        vm.expectRevert();
        dao.castVote(id, true, ALICE);
    }

    function test_CannotVoteTwiceOnOneProposal() public {
        uint256 id = _propose();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.AlreadyVoted.selector, id, alice));
        dao.castVote(id, true, 1);
    }

    function test_VotesCannotLeaveBeforeTheProposalCloses() public {
        uint256 id = _propose();

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDao.VotingStillOpen.selector, id, block.timestamp + dao.VOTING_PERIOD())
        );
        dao.withdrawVote(id);
    }

    function test_VotesAreReturnedOnlyToTheVoterAfterClose() public {
        uint256 id = _propose();
        _approve(bob, BOB);
        vm.prank(bob);
        dao.castVote(id, false, BOB);

        _closeVoting();
        vm.prank(alice);
        dao.withdrawVote(id);
        vm.prank(bob);
        dao.withdrawVote(id);

        assertEq(token.balanceOf(alice), ALICE, "Alice did not recover her vote");
        assertEq(token.balanceOf(bob), BOB, "Bob did not recover his vote");
        assertEq(token.balanceOf(address(dao)), 0, "the DAO retained voting tokens");
    }

    function test_ProposingBelowTheThresholdIsRefused() public {
        uint256 dust = 1 ether;
        _approve(carol, dust);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.BelowProposalThreshold.selector, dust, 10 ether));
        dao.propose(CEILING, dust);
    }

    // -----------------------------------------------------------------------
    // One DAO and address per chain
    // -----------------------------------------------------------------------

    function test_NoSuchChainGetsNoDao() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDaoFactory.NoSuchChain.selector, uint256(1112))
        );
        factory.create(1112);
    }

    function test_EveryChainGetsItsOwnContract() public {
        address other = factory.create(CHAIN + 1);
        assertTrue(other != address(dao), "two chains should not share a DAO");
        assertEq(VoidChainDao(other).tokenId(), CHAIN + 1, "the clone is bound to the wrong chain");
        assertEq(dao.tokenId(), CHAIN, "the first clone changed chain");
    }

    function test_AChainGetsOneDao() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDaoFactory.AlreadyCreated.selector, CHAIN, address(dao))
        );
        factory.create(CHAIN);
    }

    function test_TheAddressIsPredictable() public {
        uint256 chain = 900;
        address predicted = factory.predict(chain);
        assertEq(factory.create(chain), predicted, "the DAO landed somewhere else");
    }

    function test_ABatchCreatesARunAndToleratesOverlap() public {
        factory.createMany(10, 14);
        for (uint256 id = 10; id <= 14; ++id) {
            address d = factory.daoOf(id);
            assertTrue(d != address(0), "chain got no DAO");
            assertEq(VoidChainDao(d).tokenId(), id, "clone bound to the wrong chain");
            assertEq(runtime.daoOf(id), d, "the runtime did not record it");
        }

        address before = factory.daoOf(12);
        factory.createMany(12, 16);
        assertEq(factory.daoOf(12), before, "an existing DAO was replaced");
        assertTrue(factory.daoOf(16) != address(0), "the rest of the batch was skipped");
    }

    function test_ABatchCannotRunPastTheCollection() public {
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainDaoFactory.NoSuchChain.selector, uint256(1110))
        );
        factory.createMany(1110, 1112);
    }

    function test_TheImplementationCannotBeClaimed() public {
        VoidChainDao master = VoidChainDao(factory.implementation());
        assertEq(master.tokenId(), type(uint256).max, "the master should be bound already");

        vm.expectRevert(VoidChainDao.AlreadyInitialised.selector);
        master.initialise(5, IVoidChainAppRuntime(address(runtime)), IERC20(address(token)));
    }

    function test_ACloneCannotBeRebound() public {
        vm.expectRevert(VoidChainDao.AlreadyInitialised.selector);
        dao.initialise(CHAIN + 5, IVoidChainAppRuntime(address(runtime)), IERC20(address(token)));
    }

    // -----------------------------------------------------------------------
    // Quorum and outcome
    // -----------------------------------------------------------------------

    function test_CarriedProposalSetsTheCeilingOnItsOwnChain() public {
        uint256 id = _propose();
        _closeVoting();
        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Succeeded));

        dao.execute(id);

        assertEq(runtime.ceilingOf(CHAIN), CEILING, "the ceiling was not applied");
        assertTrue(runtime.wasSet(CHAIN), "the chain was not touched");
        assertFalse(runtime.wasSet(CHAIN + 1), "a chain nobody voted on was touched");
    }

    function test_BelowQuorumIsDefeated() public {
        // Alice retains 600 VOID but the supply rises to 10,000, so 600 votes
        // are enough to ask (1%) but not enough to decide (10%).
        token.mint(carol, 9_000 ether);
        uint256 id = _propose();
        _closeVoting();

        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
        vm.expectRevert();
        dao.execute(id);
    }

    function test_MoreAgainstThanForIsDefeated() public {
        token.mint(bob, 300 ether);
        uint256 id = _propose();
        _approve(bob, 700 ether);
        vm.prank(bob);
        dao.castVote(id, false, 700 ether);
        _closeVoting();

        assertEq(uint256(dao.state(id)), uint256(VoidChainDao.State.Defeated));
    }

    function test_CannotExecuteTwice() public {
        uint256 id = _propose();
        _closeVoting();
        dao.execute(id);
        vm.expectRevert(abi.encodeWithSelector(VoidChainDao.AlreadyExecuted.selector, id));
        dao.execute(id);
    }

    function test_AnyoneCanExecuteACarriedProposal() public {
        uint256 id = _propose();
        _closeVoting();

        vm.prank(address(0xDEADBEEF));
        dao.execute(id);
        assertEq(runtime.ceilingOf(CHAIN), CEILING);
    }
}
