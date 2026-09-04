// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed as IRuntimeDeed,
    IERC20,
    IVoidChainTreasury,
    IVoidPriceOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {
    VoidChainDao,
    IVoidChainAppRuntime,
    IVoidChainDeed as IDaoDeed,
    IVoidVotes
} from "../contracts/parent/VoidChainDao.sol";
import {VoidChainDaoFactory} from "../contracts/parent/VoidChainDaoFactory.sol";
import {VoidTestToken} from "../contracts/testnet/VoidTestToken.sol";

contract GovernanceDeed is IRuntimeDeed {
    mapping(uint256 => address) public owners;

    function setOwner(uint256 tokenId, address owner) external {
        owners[tokenId] = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return owners[tokenId];
    }
}

contract GovernanceTreasury is IVoidChainTreasury {
    address public protocolTreasury = address(0xD00D);

    function settle(uint256, uint256) external {}
    function settleTo(uint256, address, uint256) external {}
    function creditTo(address, uint256) external {}
}

/// @dev A registry-shaped app is enough to prove admission control. It is not
///      called in this test, so it needs no app logic beyond the immutable IDs.
contract GovernanceTestApp {
    uint256 public immutable chainId;
    address public immutable runtime;

    constructor(uint256 chainId_, address runtime_) {
        chainId = chainId_;
        runtime = runtime_;
    }
}

/// @notice A chain enters DAO-only policy at genesis, with no holder escape hatch.
contract GovernanceLockTest is Test {
    uint256 internal constant CHAIN = 7;
    uint256 internal constant STARTING_FEE = 0.001 ether;
    uint256 internal constant VOTED_FEE = 0.002 ether;

    address internal holder = address(0xD33D);
    address internal voter = address(0xA11CE);

    VoidTestToken internal token;
    GovernanceDeed internal deed;
    GovernanceTreasury internal treasury;
    VoidChainAppRuntime internal runtime;
    VoidChainDao internal dao;

    function setUp() public {
        token = new VoidTestToken();
        deed = new GovernanceDeed();
        treasury = new GovernanceTreasury();
        runtime = new VoidChainAppRuntime(
            IRuntimeDeed(address(deed)), IERC20(address(token)), IVoidChainTreasury(address(treasury))
        );

        deed.setOwner(CHAIN, holder);
        token.mintTo(voter, 1_000 ether);
        vm.roll(block.number + 1);

        VoidChainDaoFactory factory = new VoidChainDaoFactory(
            IVoidChainAppRuntime(address(runtime)), IVoidVotes(address(token)), IDaoDeed(address(deed))
        );
        runtime.setDaoFactoryOnce(address(factory));
        dao = VoidChainDao(factory.create(CHAIN));

        vm.prank(holder);
        runtime.activate(CHAIN, STARTING_FEE);
    }

    function _pass(VoidChainDao.Action[] memory actions, string memory description) internal {
        vm.prank(holder);
        uint256 proposalId = dao.propose(actions, description);
        vm.prank(voter);
        dao.castVote(proposalId, true);
        vm.warp(block.timestamp + dao.VOTING_PERIOD() + 1);
        dao.execute(proposalId);
    }

    function _action(bytes memory data) internal view returns (VoidChainDao.Action[] memory actions) {
        actions = new VoidChainDao.Action[](1);
        actions[0] = VoidChainDao.Action({target: address(runtime), data: data});
    }

    function test_activationRequiresARegisteredDao() public {
        uint256 ungovernedChain = CHAIN + 1;
        deed.setOwner(ungovernedChain, holder);
        VoidChainAppRuntime fresh = new VoidChainAppRuntime(
            IRuntimeDeed(address(deed)), IERC20(address(token)), IVoidChainTreasury(address(treasury))
        );

        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.DaoNotRegistered.selector, ungovernedChain)
        );
        fresh.activate(ungovernedChain, STARTING_FEE);
    }

    function test_holderCannotChangePolicyAfterGenesis() public {
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN, holder)
        );
        runtime.setFee(CHAIN, VOTED_FEE);

        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN, holder)
        );
        runtime.setPermissionlessDeploy(CHAIN, false);

        _pass(
            _action(abi.encodeCall(VoidChainAppRuntime.setFee, (CHAIN, VOTED_FEE))),
            "Set the transaction fee"
        );
        (, uint256 fee,,,,,) = runtime.apps(CHAIN);
        assertEq(fee, VOTED_FEE);
    }

    function test_closedChainAdmissionRequiresTheDaoFromGenesis() public {
        _pass(
            _action(abi.encodeCall(VoidChainAppRuntime.setPermissionlessDeploy, (CHAIN, false))),
            "Close new application publishing"
        );

        GovernanceTestApp app = new GovernanceTestApp(CHAIN, address(runtime));
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.DeploymentClosed.selector, CHAIN, holder)
        );
        runtime.registerApp(CHAIN, address(app));
    }

    function test_daoCanChangePolicyButNeverReturnItToTheHolder() public {
        vm.prank(holder);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.NotThisChainsDao.selector, CHAIN, holder)
        );
        runtime.setFee(CHAIN, VOTED_FEE);

        _pass(
            _action(abi.encodeCall(VoidChainAppRuntime.setFee, (CHAIN, VOTED_FEE))),
            "Set the transaction fee"
        );
        (, uint256 fee,,,,,) = runtime.apps(CHAIN);
        assertEq(fee, VOTED_FEE);
    }

    function test_protocolOracleIsPinnedOnceAndTheDeployerCannotReplaceIt() public {
        IVoidPriceOracle first = IVoidPriceOracle(address(0xA11CE));
        IVoidPriceOracle replacement = IVoidPriceOracle(address(0xB0B));

        runtime.setOracle(first);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.OracleAlreadySet.selector, address(first))
        );
        runtime.setOracle(replacement);

        assertEq(address(runtime.oracle()), address(first));
    }
}
