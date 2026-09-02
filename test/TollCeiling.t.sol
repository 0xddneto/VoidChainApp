// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "./MockOracle.sol";
import {
    VoidChainAppRuntime,
    IVoidChainDeed,
    IERC20,
    IVoidChainTreasury,
    IVoidPriceOracle as IRuntimeOracle
} from "../contracts/parent/VoidChainAppRuntime.sol";
import {VoidChainTreasury, IERC20 as ITreasuryERC20} from "../contracts/parent/VoidChainTreasury.sol";
import {IVoidChainDeed as ITreasuryDeed} from "../contracts/parent/VoidChainTreasury.sol";

contract FakeDeed is IVoidChainDeed {
    mapping(uint256 => address) public owners;
    function setOwner(uint256 t, address o) external { owners[t] = o; }
    function ownerOf(uint256 t) external view returns (address) { return owners[t]; }
}

contract MockVoid is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) allowance[f][msg.sender] = al - a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/**
 * The ceiling, enforced by the runtime.
 *
 * The DAO's own tests prove it decides correctly. These prove the decision binds:
 * an owner cannot price above what their chain's DAO voted, nobody but that DAO
 * can move the ceiling, and the arrangement cannot be undone by whoever deployed
 * the runtime.
 *
 * The boundary matters as much as the rule. A chain with no ceiling voted is
 * unrestricted, because a DAO that never spoke must not be indistinguishable
 * from one that voted zero.
 */
contract TollCeilingTest is Test {
    FakeDeed deed;
    MockVoid voidToken;
    VoidChainTreasury treasury;
    MockOracle oracle;
    VoidChainAppRuntime runtime;

    address alice = address(0xA11CE);
    address dao = address(0xDA0);
    address stranger = address(0x5747);

    uint256 constant CHAIN = 4;
    uint256 constant CEILING = 0.05 ether; // $0.05

    function setUp() public {
        deed = new FakeDeed();
        voidToken = new MockVoid();
        treasury = new VoidChainTreasury(
            ITreasuryDeed(address(deed)), ITreasuryERC20(address(voidToken)),
            address(0x9001), address(0x6009)
        );
        oracle = new MockOracle();
        runtime = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );
        runtime.setOracle(IRuntimeOracle(address(oracle)));
        runtime.setDaoOnce(dao);

        deed.setOwner(CHAIN, alice);
    }

    // -----------------------------------------------------------------------
    // The rule binds
    // -----------------------------------------------------------------------

    /// @notice With a ceiling voted, the owner prices freely up to it and no further.
    function test_OwnerPricesUpToTheCeilingAndNoFurther() public {
        vm.prank(alice);
        runtime.activate(CHAIN, 0.001 ether);

        vm.prank(dao);
        runtime.setTollCeiling(CHAIN, CEILING);

        // At the ceiling exactly: allowed. The vote sets a maximum, not a
        // forbidden value.
        vm.prank(alice);
        runtime.setFee(CHAIN, CEILING);
        assertEq(runtime.feeUsdOf(CHAIN), CEILING, "the owner should reach the ceiling");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.FeeAboveCeiling.selector, CEILING + 1, CEILING
            )
        );
        runtime.setFee(CHAIN, CEILING + 1);
    }

    /// @notice A chain nobody voted on is unrestricted. A DAO that never spoke
    ///         must not read as a DAO that voted zero.
    function test_WithoutAVoteTheChainIsUnrestricted() public {
        vm.prank(alice);
        runtime.activate(CHAIN, 0.001 ether);

        vm.prank(alice);
        runtime.setFee(CHAIN, 1_000 ether);
        assertEq(runtime.feeUsdOf(CHAIN), 1_000 ether, "an unvoted chain should be free to price");
        assertFalse(runtime.hasTollCeiling(CHAIN), "no ceiling should be recorded");
    }

    /// @notice A DAO may vote its chain free, and zero is a real ceiling.
    function test_AVotedCeilingOfZeroIsARealCeiling() public {
        vm.prank(alice);
        runtime.activate(CHAIN, 0.001 ether);

        vm.prank(dao);
        runtime.setTollCeiling(CHAIN, 0);
        assertTrue(runtime.hasTollCeiling(CHAIN), "the vote should be recorded");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(VoidChainAppRuntime.FeeAboveCeiling.selector, uint256(1), uint256(0))
        );
        runtime.setFee(CHAIN, 1);

        vm.prank(alice);
        runtime.setFee(CHAIN, 0);
        assertEq(runtime.feeUsdOf(CHAIN), 0);
    }

    /// @notice Switching a chain on obeys the ceiling too, or a chain could be
    ///         activated permanently above its own limit.
    function test_ActivatingAboveTheCeilingIsRefused() public {
        vm.prank(dao);
        runtime.setTollCeiling(CHAIN, CEILING);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                VoidChainAppRuntime.FeeAboveCeiling.selector, CEILING + 1, CEILING
            )
        );
        runtime.activate(CHAIN, CEILING + 1);

        vm.prank(alice);
        runtime.activate(CHAIN, CEILING);
        assertEq(runtime.feeUsdOf(CHAIN), CEILING);
    }

    /// @notice A ceiling voted below what a chain already charges leaves that
    ///         price standing and stops it rising. Cutting it retroactively
    ///         would surprise the owner the way an unbounded raise surprises a
    ///         user — the same wrong, mirrored.
    function test_ANewCeilingDoesNotCutThePriceAlreadySet() public {
        vm.prank(alice);
        runtime.activate(CHAIN, 1 ether);

        vm.prank(dao);
        runtime.setTollCeiling(CHAIN, CEILING);

        assertEq(runtime.feeUsdOf(CHAIN), 1 ether, "the standing price should not be cut");

        vm.prank(alice);
        vm.expectRevert();
        runtime.setFee(CHAIN, 2 ether);
    }

    // -----------------------------------------------------------------------
    // Who may move it
    // -----------------------------------------------------------------------

    /// @notice Only the DAO. Not the owner of the chain, and not a passer-by.
    function test_NobodyButTheDaoSetsACeiling() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.NotTheDao.selector, alice));
        runtime.setTollCeiling(CHAIN, CEILING);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.NotTheDao.selector, stranger));
        runtime.setTollCeiling(CHAIN, CEILING);
    }

    /// @notice The DAO is written once. A contract that can cap what every chain
    ///         charges is not something to leave behind a setter.
    function test_TheDaoIsWrittenOnce() public {
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.DaoAlreadySet.selector, dao));
        runtime.setDaoOnce(address(0xBEEF));
        assertEq(runtime.dao(), dao, "the DAO should not have moved");
    }

    /// @notice And nobody but the deployer writes it in the first place.
    function test_OnlyTheDeployerWiresTheDao() public {
        VoidChainAppRuntime fresh = new VoidChainAppRuntime(
            IVoidChainDeed(address(deed)), IERC20(address(voidToken)),
            IVoidChainTreasury(address(treasury))
        );

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VoidChainAppRuntime.NotTheDeployer.selector, stranger));
        fresh.setDaoOnce(dao);
    }

    /// @notice One chain's ceiling is one chain's. The DAO reaching a chain it
    ///         was not asked about would be the isolation failing at the top.
    function test_ACeilingBindsOnlyItsOwnChain() public {
        deed.setOwner(CHAIN + 1, alice);

        vm.prank(dao);
        runtime.setTollCeiling(CHAIN, CEILING);

        vm.prank(alice);
        runtime.activate(CHAIN + 1, 500 ether);
        assertEq(runtime.feeUsdOf(CHAIN + 1), 500 ether, "the neighbour should be untouched");
        assertFalse(runtime.hasTollCeiling(CHAIN + 1));
    }
}
